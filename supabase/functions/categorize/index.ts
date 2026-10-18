/**
 * POST /functions/v1/categorize
 *
 *   {"documentId": "..."}        categorize one document's pending rows
 *   {"limit": 200}               categorize up to N pending rows (any document)
 *   {"transactionIds": [...]}    re-categorize specific rows
 *
 * Batches rows into as few model calls as the quota allows. Confidence decides
 * what happens next:
 *
 *   >= AUTO_ACCEPT  -> status 'auto',   lands in the ledger
 *   <  AUTO_ACCEPT  -> status 'review', lands in the review queue
 *
 * Every accepted categorization also writes an alias rule, so the same merchant
 * string never costs a token again. That is the learning loop.
 */

import {
  assertQuota, buildTaxonomyBrief, corsHeaders, ensureProduct, fail, json,
  loadTaxonomy, recordLlmUsage, serviceClient, userIdFromRequest,
} from '../_shared/mod.ts';
import { completeJson, QuotaExceededError } from '../_shared/llm.ts';
import { canonicalProductName, normalizeProductName } from '../_shared/taxonomy-seed.ts';
import type { CategorizeResult } from '../_shared/types.ts';

const AUTO_ACCEPT = 0.75;
const BATCH_SIZE = 25;
const MAX_ROWS_PER_CALL = 2000;

const SYSTEM = `You categorize personal-finance transactions into a two-level taxonomy:
a fixed SECTOR and a per-user PRODUCT underneath it.

Return ONLY a JSON object: {"results": [ ... ]} with exactly one result per input
row, in the same order. Each result:
  product     string  -- the product name. Reuse an existing name EXACTLY as
                         listed when one fits. Only invent a new name when
                         nothing existing genuinely applies.
  sector      string  -- one of the sector slugs listed
  confidence  number  -- 0..1, your honest confidence
  reason      string  -- at most 12 words, the decisive evidence

Rules:
- Product names are short and reusable: "Cha", "Uber", "Rent". Never put an
  amount, date or order id in a product name.
- Prefer an existing product over inventing one. A new product must be something
  this user will plausibly buy again.
- Money IN (direction=credit) always goes in the "income" sector.
- Use the note and payee: "Brokerage" on a housing payment is housing, not a fee.
- A lender's name ("Me -> Ayantika : Myntra order") is loans_transfers, even
  though Myntra is a shop -- the money went to a person, not a merchant.
- If you truly cannot tell, say so with low confidence rather than guessing
  confidently. A wrong high-confidence answer is worse than an honest low one.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('use POST', 405);

  const admin = serviceClient();

  try {
    const userId = await userIdFromRequest(req, admin);
    if (!userId) return fail('unauthenticated', 401);

    const body = await req.json().catch(() => ({})) as {
      documentId?: string;
      limit?: number;
      transactionIds?: string[];
      dryRun?: boolean;
    };

    // -- select the rows to categorize ---------------------------------------
    // source_ref is selected because it carries the sectorHint the deterministic
    // pass computed -- that hint is what keeps the prompt brief small.
    let query = admin
      .from('transactions')
      .select('id, raw_description, note, payee, amount, direction, occurred_at, product_id, source_ref')
      .eq('user_id', userId);

    if (Array.isArray(body.transactionIds) && body.transactionIds.length > 0) {
      query = query.in('id', body.transactionIds.slice(0, MAX_ROWS_PER_CALL));
    } else {
      query = query.eq('categorize_status', 'pending');
      if (body.documentId) query = query.eq('document_id', body.documentId);
      query = query.limit(Math.min(body.limit ?? MAX_ROWS_PER_CALL, MAX_ROWS_PER_CALL));
    }

    const { data: rows, error: rowsErr } = await query;
    if (rowsErr) return fail(`query failed: ${rowsErr.message}`, 500);
    if (!rows || rows.length === 0) return json({ categorized: 0, message: 'nothing pending' });

    // -- quota: figure out how many batches we can afford BEFORE calling ------
    const { used, cap } = await assertQuota(admin, userId, 1);
    const remaining = Math.max(0, cap - used);
    const batchesNeeded = Math.ceil(rows.length / BATCH_SIZE);
    const batchesAllowed = Math.min(batchesNeeded, remaining);

    if (batchesAllowed === 0) {
      throw new QuotaExceededError(used, cap);
    }

    const taxData = await loadTaxonomy(admin, userId);
    const tax = buildTaxonomy(taxData.sectors, taxData.products, taxData.aliases);
    const validSlugs = new Set(tax.sectors.map((s) => s.slug));

    const processRows = rows.slice(0, batchesAllowed * BATCH_SIZE);
    const deferred = rows.length - processRows.length;

    let calls = 0;
    let accepted = 0;
    let queuedForReview = 0;
    let newProducts = 0;
    let aliasesWritten = 0;
    const failures: Array<{ id: string; reason: string }> = [];

    const productNameToId = new Map<string, string>();
    for (const p of tax.products) productNameToId.set(p.normalizedName, p.id);

    for (let b = 0; b < processRows.length; b += BATCH_SIZE) {
      const batch = processRows.slice(b, b + BATCH_SIZE);

      const payload = batch.map((r, i) => ({
        i,
        description: r.raw_description,
        note: r.note ?? null,
        payee: r.payee ?? null,
        amount: Number(r.amount),
        direction: r.direction,
        date: String(r.occurred_at).slice(0, 10),
      }));

      // Sector hints from the keyword priors, so the brief only lists products
      // that could plausibly match. This is what keeps the prompt small.
      const hints = new Set<string>();
      for (const r of batch) {
        const hint = (r as { source_ref?: { sectorHint?: string | null } }).source_ref?.sectorHint;
        if (hint) hints.add(hint);
      }
      if (batch.some((r) => r.direction === 'credit')) hints.add('income');

      const brief = buildTaxonomyBrief(tax, [...hints]);

      try {
        const { data, usage } = await completeJson<{ results?: CategorizeResult[] }>(
          {
            system: SYSTEM,
            user: `${brief}\n\nROWS:\n${JSON.stringify(payload)}`,
            temperature: 0,
            maxOutputTokens: 4096,
          },
          (u, fn) => recordLlmUsage(admin, userId, fn, u),
          'categorize',
        );
        calls++;

        const results = Array.isArray(data.results) ? data.results : [];

        for (let i = 0; i < batch.length; i++) {
          const row = batch[i];
          const result = results[i];

          if (!result || typeof result.product !== 'string' || !result.product.trim()) {
            failures.push({ id: row.id as string, reason: 'model returned no product for this row' });
            continue;
          }

          let sectorSlug = String(result.sector ?? '').trim();
          if (!validSlugs.has(sectorSlug)) {
            sectorSlug = row.direction === 'credit' ? 'income' : 'uncategorized';
          }
          // Credits are always income regardless of what the model said.
          if (row.direction === 'credit') sectorSlug = 'income';

          const sector = tax.sectorBySlug.get(sectorSlug);
          if (!sector) {
            failures.push({ id: row.id as string, reason: `unknown sector ${sectorSlug}` });
            continue;
          }

          const confidence = clamp01(Number(result.confidence ?? 0));
          const cleanName = canonicalProductName(result.product);

          if (body.dryRun) {
            if (confidence >= AUTO_ACCEPT) accepted++;
            else queuedForReview++;
            continue;
          }

          // Get or create the product. Creating is how the taxonomy grows.
          let productId = productNameToId.get(normalizeProductName(cleanName));
          if (!productId) {
            const created = await ensureProduct(admin, userId, cleanName, sector.id);
            if (!created) {
              failures.push({ id: row.id as string, reason: `could not create product "${cleanName}"` });
              continue;
            }
            productId = created.id;
            productNameToId.set(created.normalizedName, created.id);
            tax.products.push(created);
            tax.byNormalizedName.set(created.normalizedName, created);
            newProducts++;
          }

          const status = confidence >= AUTO_ACCEPT ? 'auto' : 'review';
          const { error: updErr } = await admin
            .from('transactions')
            .update({
              product_id: productId,
              categorize_status: status,
              confidence,
              categorize_reason: String(result.reason ?? '').slice(0, 200) || null,
              llm_model: usage.model,
            })
            .eq('id', row.id)
            .eq('user_id', userId);

          if (updErr) {
            failures.push({ id: row.id as string, reason: updErr.message });
            continue;
          }

          if (status === 'auto') accepted++;
          else queuedForReview++;

          // -- learning loop --------------------------------------------------
          // Only for confident categorizations, and only when the description is
          // not already just the product name (an alias "Cha" -> Cha teaches
          // nothing and would shadow better rules).
          if (status === 'auto') {
            const desc = String(row.raw_description ?? '').trim();
            const lead = desc.split('|')[0].trim();
            const pattern = (lead.length > 2 && normalizeProductName(lead) !== normalizeProductName(cleanName))
              ? lead
              : null;

            if (pattern) {
              const { error: aliasErr } = await admin.from('aliases').upsert({
                user_id: userId,
                product_id: productId,
                pattern: pattern.toLowerCase(),
                pattern_type: 'contains',
                source: 'llm',
                confidence: Math.min(confidence, 0.95),
              }, { onConflict: 'user_id,pattern' });
              // A missing unique index makes this a plain insert; either way a
              // failure here must not lose the categorization itself.
              if (!aliasErr) aliasesWritten++;
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const row of batch) failures.push({ id: row.id as string, reason: msg });
        // A quota error mid-run should stop the loop rather than burn retries.
        if (err instanceof QuotaExceededError) break;
      }
    }

    return json({
      requested: rows.length,
      processed: processRows.length,
      deferred,
      llmCalls: calls,
      quota: { used: used + calls, cap },
      accepted,
      queuedForReview,
      newProducts,
      aliasesWritten,
      failures: failures.length,
      failureSamples: failures.slice(0, 10),
      dryRun: body.dryRun === true,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return json({ error: err.message, used: err.used, cap: err.cap }, 429);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('categorize failed:', msg);
    return fail(msg, 500);
  }
});

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
