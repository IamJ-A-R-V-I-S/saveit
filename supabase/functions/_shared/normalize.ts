/**
 * Row normalization + dedup key.
 *
 * The dedup key is what makes re-uploading an overlapping statement a no-op.
 * It MUST stay byte-for-byte identical to public.make_dedup_key() in
 * supabase/migrations/0004_views.sql, or a backfill run in SQL would compute
 * different keys than the ingest path and silently double-count.
 */

import type { Direction, StagedRow } from './types.ts';
import { parseAmount, parseDate, parseDirection } from './parse.ts';

/**
 * Lowercase, strip everything that is not alphanumeric, collapse runs of
 * separators to a single space, trim.
 *
 * Mirrors: btrim(regexp_replace(lower(x), '[^a-z0-9]+', ' ', 'g'))
 *
 * This is deliberately aggressive: "RADHIKAPUR EXPRESS" and "Radhikapur
 * express " must produce the same key so a re-export dedups, while two legs of
 * the same journey stay distinct because their amounts differ.
 */
export function normalizeDescription(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Format a number the way Postgres `to_char(x, 'FM999999990.00')` does. */
export function formatAmount(n: number): string {
  return (Math.round(Math.abs(n) * 100) / 100).toFixed(2);
}

/** Format a Date the way Postgres `to_char(ts at time zone 'utc', ...)` does. */
export function formatTimestampUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * SHA-256 of the canonical dedup tuple, as hex.
 *
 * Web Crypto is available in both Deno (edge functions) and Node 22 (tests),
 * so no dependency is needed.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface DedupKeyInput {
  userId: string;
  accountId: string | null;
  occurredAt: Date;
  amount: number;
  description: string | null;
  /** Position among rows that are otherwise identical. Default 0. */
  occurrence?: number;
}

/** Build the dedup key. Must match public.make_dedup_key() exactly. */
export async function makeDedupKey(input: DedupKeyInput): Promise<string> {
  const canonical = [
    input.userId,
    input.accountId ?? '',
    formatTimestampUtc(input.occurredAt),
    formatAmount(input.amount),
    normalizeDescription(input.description),
    String(input.occurrence ?? 0),
  ].join('|');
  return sha256Hex(canonical);
}

/**
 * Assign occurrence indices to rows whose base identity is identical.
 *
 * Two ₹542 exam fees in the same minute are different transactions; two rows
 * that are identical down to the second are the same transaction listed twice.
 * Indexing by sorted position within a batch is deterministic, so re-uploading
 * the same file reproduces the same indices and the upsert still dedups.
 */
export function assignOccurrences<T extends { occurredAt: Date; amount: number; rawDescription: string }>(
  rows: T[],
): number[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${formatTimestampUtc(r.occurredAt)}|${formatAmount(r.amount)}|${
      normalizeDescription(r.rawDescription)
    }`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n;
  });
}

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

export interface ColumnValues {
  date?: string;
  amount?: string;
  direction?: string;
  description?: string;
  category?: string;
  account?: string;
  note?: string;
  currency?: string;
  payee?: string;
}

/**
 * Turn one parsed row into a StagedRow.
 *
 * Returns null (with a reason) rather than throwing, so a single malformed line
 * cannot abort a 5,000-row import. The caller counts skips and reports them.
 */
export function stageRow(
  cols: ColumnValues,
  opts: { dayFirst?: boolean; defaultAccount?: string; defaultCurrency?: string } = {},
): { row?: StagedRow; skip?: string } {
  const occurredAt = parseDate(cols.date ?? '', opts.dayFirst ?? true);
  if (!occurredAt) return { skip: `unparseable date: ${JSON.stringify(cols.date)}` };

  const parsed = parseAmount(cols.amount ?? '');
  if (!parsed) return { skip: `unparseable amount: ${JSON.stringify(cols.amount)}` };
  if (parsed.amount === 0) return { skip: 'zero amount' };

  // Direction: trust an explicit Dr/Cr column when present, otherwise fall back
  // to the sign of the amount. The sample uses a `type` column (Expenses/Income)
  // AND negative amounts, so both paths agree -- but a bank export with
  // unsigned amounts in separate Withdrawal/Deposit columns needs the explicit
  // path.
  let direction: Direction | null = parseDirection(cols.direction);
  if (!direction) direction = parsed.negative ? 'debit' : 'credit';

  // A tracker export labels the row with its own category ("Cha") and keeps the
  // free-text context in `note`. A bank statement puts a mangled merchant string
  // in `description` and has no note. Build the richest description available,
  // because that string is the only thing the categorizer gets to read.
  const parts = [cols.category, cols.description, cols.note, cols.payee]
    .map((p) => (p ?? '').trim())
    .filter(Boolean);
  const rawDescription = parts.length > 0 ? parts.join(' | ') : '';

  if (!rawDescription) return { skip: 'no description, category or note to categorize from' };

  return {
    row: {
      occurredAt,
      amount: parsed.amount,
      direction,
      currency: (cols.currency ?? opts.defaultCurrency ?? 'INR').trim().toUpperCase() || 'INR',
      rawDescription,
      note: cols.note?.trim() || null,
      payee: cols.payee?.trim() || null,
      sourceRef: {
        account: cols.account?.trim() || opts.defaultAccount || null,
        category: cols.category?.trim() || null,
        description: cols.description?.trim() || null,
      },
    },
  };
}

/** Group staged rows by the account name they claim, so the caller can map
 *  each to an accounts.id (creating accounts on first sight). */
export function groupByAccount(rows: Array<StagedRow & { _account?: string }>): Map<string, StagedRow[]> {
  const out = new Map<string, StagedRow[]>();
  for (const r of rows) {
    const key = r._account ?? 'unknown';
    const list = out.get(key);
    if (list) list.push(r);
    else out.set(key, [r]);
  }
  return out;
}
