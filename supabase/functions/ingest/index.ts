/**
 * POST /functions/v1/ingest
 *
 * Upload a statement, get transactions.
 *
 *   multipart/form-data  file=<csv|pdf|png|jpg>  [accountId]  [hint]
 *
 * The pipeline is deliberately split so the expensive part is rare:
 *
 *   parse (deterministic)  ->  stage  ->  resolve taxonomy (deterministic)
 *                                      ->  upsert (idempotent)
 *
 * Only rows the deterministic resolver cannot place are left `pending` for the
 * categorize function. On a tracker export that is ~0.02% of rows; on a bank PDF
 * it will be most of them. See docs/DATA-PROFILE.md §4.
 *
 * The LLM is called here ONLY for PDFs/images and for salvaging text with no
 * usable header. Reading a CSV never costs a token.
 */

import {
  corsHeaders, ensureAccount, fail, json, recordLlmUsage, serviceClient,
  userIdFromRequest,
} from '../_shared/db.ts';
import {
  detectDelimiter, detectHeaderRow, isUsableMap, mapColumns, parseDelimited,
} from '../_shared/parse.ts';
import { assignOccurrences, makeDedupKey, stageRow } from '../_shared/normalize.ts';
import { buildTaxonomy, resolveDeterministic } from '../_shared/taxonomy.ts';
import { loadTaxonomy } from '../_shared/db.ts';
import { seedTaxonomyIfEmpty } from '../_shared/seed.ts';
import { extractFromImage, extractFromPdf, rowsFromLlmText, type ExtractedRow } from '../_shared/extract.ts';
import type { ColumnValues } from '../_shared/normalize.ts';
import type { DocumentKind, StagedRow } from '../_shared/types.ts';
import { QuotaExceededError } from '../_shared/llm.ts';

const BUCKET = 'statements';
const MAX_BYTES = 25 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('use POST', 405);

  const admin = serviceClient();

  try {
    const userId = await userIdFromRequest(req, admin);
    if (!userId) return fail('unauthenticated', 401);

    const form = await req.formData().catch(() => null);
    if (!form) return fail('expected multipart/form-data');

    const file = form.get('file');
    if (!(file instanceof File)) return fail('missing "file" part');
    if (file.size === 0) return fail('file is empty');
    if (file.size > MAX_BYTES) return fail(`file exceeds ${MAX_BYTES / 1024 / 1024} MB limit`, 413);

    const requestedAccountId = (form.get('accountId') as string | null) ?? null;
    const hint = (form.get('hint') as string | null) ?? null;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectKind(file.name, file.type);

    // -- document row first, so the storage path can include its id -----------
    const { data: doc, error: docErr } = await admin
      .from('documents')
      .insert({
        user_id: userId,
        account_id: requestedAccountId,
        filename: file.name,
        kind,
        size_bytes: file.size,
        status: 'parsing',
      })
      .select('id')
      .single();
    if (docErr || !doc) return fail(`could not create document record: ${docErr?.message}`, 500);

    const documentId = doc.id as string;
    const storagePath = `${userId}/${documentId}/${sanitizeFilename(file.name)}`;

    const sha256 = await sha256HexBytes(bytes);
    const { error: uploadErr } = await admin.storage
      .from(BUCKET)
      .upload(storagePath, bytes, { contentType: file.type || 'application/octet-stream', upsert: true });
    if (uploadErr) {
      await markDocumentFailed(admin, documentId, `storage upload failed: ${uploadErr.message}`);
      return fail(`storage upload failed: ${uploadErr.message}`, 500);
    }

    await admin.from('documents').update({ storage_path: storagePath, sha256 }).eq('id', documentId);

    // -- parse ----------------------------------------------------------------
    const record = (u: Parameters<typeof recordLlmUsage>[3], fn: string) =>
      recordLlmUsage(admin, userId, fn, u);

    let parsed: ParseOutcome;
    try {
      parsed = await parseDocument(admin, userId, documentId, kind, bytes, file.name, hint, record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markDocumentFailed(admin, documentId, msg);
      const status = err instanceof QuotaExceededError ? 429 : 422;
      return fail(msg, status, { documentId });
    }

    if (parsed.rows.length === 0) {
      await admin.from('documents').update({
        status: 'needs_review', row_count: 0,
        error_message: parsed.warning ?? 'no transaction rows found in this document',
        source_type: parsed.sourceType ?? null,
        header_map: parsed.headerMap ?? null,
      }).eq('id', documentId);
      return json({
        documentId, kind, rowCount: 0, inserted: 0, duplicates: 0,
        skipped: 0, pendingCategorization: 0,
        warning: parsed.warning ?? 'no transaction rows found',
      }, 200);
    }

    // -- taxonomy + accounts ---------------------------------------------------
    const seed = await seedTaxonomyIfEmpty(admin, userId);
    const taxData = await loadTaxonomy(admin, userId);
    const tax = buildTaxonomy(taxData.sectors, taxData.products, taxData.aliases);

    const accountNames = [...new Set(parsed.rows.map((r) => r.accountName).filter(Boolean))] as string[];
    const accountIdByName = new Map<string, string>();
    for (const name of accountNames) {
      const id = await ensureAccount(admin, userId, name);
      if (id) accountIdByName.set(name, id);
    }

    const defaultAccountId = requestedAccountId
      ?? accountIdByName.values().next().value
      ?? null;

    if (!defaultAccountId) {
      await markDocumentFailed(admin, documentId, 'no account could be resolved for these rows');
      return fail('no account resolved; pass accountId explicitly', 422, { documentId });
    }

    // -- resolve + dedupe ------------------------------------------------------
    const staged = parsed.rows.map((r) => r.row);
    const occurrences = assignOccurrences(staged);

    const toInsert: Array<Record<string, unknown>> = [];
    let resolvedFree = 0;
    let needsReviewCount = 0;
    let pending = 0;
    const skipped: Array<{ line: number; reason: string }> = [];

    for (let i = 0; i < parsed.rows.length; i++) {
      const entry = parsed.rows[i];
      const accountId = accountIdByName.get(entry.accountName ?? '') ?? defaultAccountId;

      const resolution = resolveDeterministic(tax, entry.row.rawDescription);
      if (resolution.via === 'exact' || resolution.via === 'alias') resolvedFree++;
      if (resolution.needsReview) needsReviewCount++;

      const dedupKey = await makeDedupKey({
        userId,
        accountId,
        occurredAt: entry.row.occurredAt,
        amount: entry.row.amount,
        description: entry.row.rawDescription,
        occurrence: occurrences[i],
      });

      // Money IN is always income, whatever the product is. A credit tagged
      // "Gifts" is received, not given; direction carries that, so the product
      // does not need two variants. See taxonomy-seed.ts header.
      const isCredit = entry.row.direction === 'credit';
      const incomeSector = tax.sectorBySlug.get('income');
      let productId = resolution.product?.id ?? null;
      if (isCredit && productId && incomeSector) {
        const p = tax.products.find((x) => x.id === productId);
        // Only redirect if the product is not already an income product.
        if (p && p.sectorId !== incomeSector.id) {
          const incomeProduct = tax.products.find((x) => x.sectorId === incomeSector.id);
          if (incomeProduct) productId = incomeProduct.id;
        }
      }

      // A confident exact/alias match is accepted outright -- UNLESS it landed
      // in the `uncategorized` sector, which is where deliberately ambiguous
      // products like "Charges, Fees" live. Those must reach a human even when
      // the match itself is certain, because the note decides the real sector.
      const confident = (resolution.via === 'exact' || resolution.via === 'alias')
        && !resolution.needsReview;
      const status = confident ? 'auto' : 'pending';
      if (!confident) pending++;

      toInsert.push({
        user_id: userId,
        account_id: accountId,
        document_id: documentId,
        product_id: productId,
        amount: entry.row.amount,
        direction: entry.row.direction,
        currency: entry.row.currency,
        occurred_at: entry.row.occurredAt.toISOString(),
        raw_description: entry.row.rawDescription,
        note: entry.row.note ?? null,
        payee: entry.row.payee ?? null,
        dedup_key: dedupKey,
        source_ref: {
          ...entry.row.sourceRef,
          line: entry.line,
          page: entry.page ?? null,
          sectorHint: resolution.via === 'keyword' ? resolution.sectorSlug : null,
        },
        categorize_status: status,
        confidence: resolution.via === 'none' ? null : resolution.confidence,
      });
    }

    // -- idempotent upsert ----------------------------------------------------
    // ignoreDuplicates makes re-uploading an overlapping statement a no-op, and
    // the returned rows are exactly the newly inserted ones -- so the duplicate
    // count falls out for free.
    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const { data: insertedRows, error } = await admin
        .from('transactions')
        .upsert(toInsert.slice(i, i + CHUNK), {
          onConflict: 'user_id,dedup_key',
          ignoreDuplicates: true,
        })
        .select('id');
      if (error) {
        await markDocumentFailed(admin, documentId, `insert failed: ${error.message}`);
        return fail(`insert failed: ${error.message}`, 500, { documentId });
      }
      inserted += insertedRows?.length ?? 0;
    }

    const duplicates = toInsert.length - inserted;

    const dates = staged.map((r) => r.occurredAt).sort((a, b) => a.getTime() - b.getTime());
    const periodStart = dates[0];
    const periodEnd = dates[dates.length - 1];

    // Per-month counts, so the UI can warn about a statement that only covers
    // part of a month. Sparse coverage is normal for this data (§3.2) and must
    // not be read as "the user spent nothing in March".
    const coverage: Record<string, number> = {};
    for (const d of staged) {
      const m = d.occurredAt.toISOString().slice(0, 7);
      coverage[m] = (coverage[m] ?? 0) + 1;
    }

    await admin.from('documents').update({
      status: pending > 0 ? 'needs_review' : 'parsed',
      source_type: parsed.sourceType ?? null,
      row_count: parsed.rows.length,
      imported_count: inserted,
      duplicate_count: duplicates,
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      header_map: parsed.headerMap ?? null,
      coverage,
      error_message: parsed.warning ?? null,
    }).eq('id', documentId);

    return json({
      documentId,
      kind,
      sourceType: parsed.sourceType ?? null,
      rowCount: parsed.rows.length,
      inserted,
      duplicates,
      skipped: skipped.length,
      skippedSamples: skipped.slice(0, 10),
      resolvedWithoutLlm: resolvedFree,
      needsReview: needsReviewCount,
      pendingCategorization: pending,
      taxonomySeeded: seed.seeded,
      productsSeeded: seed.products,
      llmCallsUsed: parsed.llmCalls,
      period: {
        start: periodStart.toISOString().slice(0, 10),
        end: periodEnd.toISOString().slice(0, 10),
      },
      coverage,
      warning: parsed.warning ?? null,
      nextStep: pending > 0
        ? `POST /functions/v1/categorize with {"documentId":"${documentId}"} to categorize ${pending} row(s)`
        : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('ingest failed:', msg);
    return fail(msg, 500);
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ParsedEntry {
  row: StagedRow;
  accountName: string | null;
  line: number | null;
  page: number | null;
}

interface ParseOutcome {
  rows: ParsedEntry[];
  headerMap?: Record<string, unknown> | null;
  sourceType?: string | null;
  warning?: string | null;
  llmCalls: number;
}

type RecordUsage = (u: { provider: string; model: string; promptTokens: number; completionTokens: number }, fn: string) => Promise<void> | void;

function detectKind(filename: string, mime: string): DocumentKind {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mime.includes('pdf') || ext === 'pdf') return 'pdf';
  if (ext === 'xlsx' || ext === 'xls' || mime.includes('spreadsheetml')) return 'xlsx';
  if (ext === 'csv' || mime.includes('csv')) return 'csv';
  if (ext === 'json' || mime.includes('json')) return 'json';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) || mime.startsWith('image/')) return 'pdf'; // image path
  if (ext === 'txt' || mime.startsWith('text/')) return 'csv';
  return 'other';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'statement';
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function markDocumentFailed(
  admin: ReturnType<typeof serviceClient>,
  documentId: string,
  message: string,
): Promise<void> {
  await admin.from('documents').update({ status: 'failed', error_message: message.slice(0, 2000) }).eq('id', documentId);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Parse any supported document into staged rows. */
async function parseDocument(
  admin: ReturnType<typeof serviceClient>,
  userId: string,
  documentId: string,
  kind: DocumentKind,
  bytes: Uint8Array,
  filename: string,
  hint: string | null,
  record: RecordUsage,
): Promise<ParseOutcome> {
  if (kind === 'xlsx') {
    throw new Error(
      'XLSX is not supported yet. Open the file in Excel/Sheets and re-save as CSV, ' +
      'then upload the CSV.',
    );
  }

  // ---- PDF / image: the only path that always needs the model ---------------
  if (kind === 'pdf') {
    const isImage = /\.(png|jpe?g|webp)$/i.test(filename);
    const mime = isImage
      ? (filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
      : 'application/pdf';
    const b64 = toBase64(bytes);

    const result = isImage
      ? await extractFromImage(b64, mime, record)
      : await extractFromPdf(b64, record, { hint: hint ?? undefined });

    return {
      rows: await stageExtracted(admin, userId, result.rows, result.meta.day_first ?? true),
      sourceType: result.meta.source_type ?? (isImage ? 'image' : 'pdf'),
      warning: result.meta.notes ?? null,
      llmCalls: 1,
    };
  }

  // ---- delimited text: deterministic ---------------------------------------
  const text = new TextDecoder('utf-8').decode(bytes);
  const delimiter = detectDelimiter(text);
  const rawRows = parseDelimited(text, delimiter);

  if (rawRows.length < 2) {
    throw new Error('file has no data rows');
  }

  const headerIndex = detectHeaderRow(rawRows);
  const header = rawRows[headerIndex];
  const map = mapColumns(header);

  if (!isUsableMap(map)) {
    // No date or no amount column: this is not a tabular statement. Fall back to
    // the model, which is the right tool for genuinely unstructured text.
    const salvaged = await rowsFromLlmText(text, record);
    return {
      rows: await stageExtracted(admin, userId, salvaged.rows, salvaged.meta.day_first ?? true),
      headerMap: map as unknown as Record<string, unknown>,
      sourceType: salvaged.meta.source_type ?? 'free-text',
      warning: `no usable header row (confidence ${map.confidence}); parsed as free text. ` +
        (salvaged.meta.notes ?? ''),
      llmCalls: 1,
    };
  }

  const dayFirst = guessDayFirst(header, map, rawRows, headerIndex);
  const rows: ParsedEntry[] = [];
  const skips: Array<{ line: number; reason: string }> = [];

  for (let i = headerIndex + 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const cols: ColumnValues = {
      date: map.date !== undefined ? r[map.date] : undefined,
      amount: map.amount !== undefined ? r[map.amount] : undefined,
      debit: map.debit !== undefined ? r[map.debit] : undefined,
      credit: map.credit !== undefined ? r[map.credit] : undefined,
      direction: map.direction !== undefined ? r[map.direction] : undefined,
      description: map.description !== undefined ? r[map.description] : undefined,
      category: map.category !== undefined ? r[map.category] : undefined,
      note: map.note !== undefined ? r[map.note] : undefined,
      currency: map.currency !== undefined ? r[map.currency] : undefined,
      payee: map.payee !== undefined ? r[map.payee] : undefined,
      account: map.account !== undefined ? r[map.account] : undefined,
    };

    const result = stageRow(cols, { dayFirst });
    if (result.skip) {
      skips.push({ line: i + 1, reason: result.skip });
      continue;
    }
    rows.push({
      row: result.row!,
      accountName: cols.account?.trim() || null,
      line: i + 1,
      page: null,
    });
  }

  if (rows.length === 0) {
    throw new Error(
      `header mapped successfully but no row parsed (first skip: ${skips[0]?.reason ?? 'n/a'})`,
    );
  }

  return {
    rows,
    headerMap: {
      delimiter,
      headerRowIndex: headerIndex,
      header,
      map,
      dayFirst,
      skippedRows: skips.length,
      skippedSamples: skips.slice(0, 10),
    } as unknown as Record<string, unknown>,
    sourceType: guessSourceType(header, filename),
    warning: skips.length > 0 ? `${skips.length} row(s) skipped as unparseable` : null,
    llmCalls: 0,
  };
}

/** Stage rows that came from the model rather than from a header map. */
async function stageExtracted(
  _admin: ReturnType<typeof serviceClient>,
  _userId: string,
  extracted: ExtractedRow[],
  dayFirst: boolean,
): Promise<ParsedEntry[]> {
  const out: ParsedEntry[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const e = extracted[i];
    const cols: ColumnValues = {
      date: e.date,
      amount: typeof e.amount === 'number' ? String(e.amount) : e.amount,
      direction: e.direction ?? undefined,
      description: e.description ?? undefined,
      category: e.category ?? undefined,
      note: e.note ?? undefined,
      currency: e.currency ?? undefined,
      payee: e.payee ?? undefined,
      account: e.account ?? undefined,
    };
    const result = stageRow(cols, { dayFirst });
    if (!result.row) continue;
    out.push({
      row: result.row,
      accountName: cols.account?.trim() || null,
      line: e.line ?? i + 1,
      page: e.page ?? null,
    });
  }
  return out;
}

/**
 * Decide day-first vs month-first from the data itself.
 *
 * If any date in the file has a first component > 12, the file is day-first and
 * that is conclusive. Only when no row disambiguates do we fall back to the
 * locale default (true -- Indian statements are day-first).
 */
function guessDayFirst(
  _header: string[],
  map: ReturnType<typeof mapColumns>,
  rows: string[][],
  headerIndex: number,
): boolean {
  if (map.date === undefined) return true;
  for (let i = headerIndex + 1; i < Math.min(rows.length, headerIndex + 200); i++) {
    const raw = rows[i][map.date];
    if (!raw) continue;
    const m = raw.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (!m) continue;
    const a = Number.parseInt(m[1], 10);
    const b = Number.parseInt(m[2], 10);
    if (a > 12 && b <= 12) return true;
    if (b > 12 && a <= 12) return false;
  }
  return true;
}

function guessSourceType(header: string[], filename: string): string {
  const h = header.map((c) => c.toLowerCase()).join('|');
  if (h.includes('envelope_id') || h.includes('custom_category')) return 'Money Manager export';
  if (h.includes('narration') || h.includes('particulars')) return 'bank statement';
  if (h.includes('utr') || h.includes('ref no')) return 'bank statement';
  return filename.toLowerCase().includes('upi') ? 'UPI statement' : 'csv';
}
