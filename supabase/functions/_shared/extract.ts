/**
 * Row extraction from unstructured documents.
 *
 * This is the ONLY place ingestion is allowed to call an LLM. CSV and other
 * delimited text go through the deterministic path in parse.ts -- see
 * docs/DATA-PROFILE.md §4 for why that matters (99.98% of a 5,535-row tracker
 * export resolves with zero model calls).
 *
 * Two strategies here:
 *   extractFromPdf   -- text PDF or scanned page. Gemini takes PDFs natively and
 *                       has vision, so one call covers both; OpenAI needs the
 *                       data-URL form, which llm.ts handles.
 *   rowsFromLlmText  -- last-resort recovery when a "CSV" turns out to be
 *                       pasted text with no usable header.
 */

import { completeJson } from './llm.ts';
import type { LlmUsage } from './types.ts';

/** One row as the model reports it. Deliberately loose -- we normalize after. */
export interface ExtractedRow {
  date?: string;
  amount?: string | number;
  direction?: string;
  description?: string;
  category?: string;
  account?: string;
  note?: string;
  currency?: string;
  payee?: string;
  /** Page/line the row came from, for source_ref traceability. */
  page?: number;
  line?: number;
}

const EXTRACT_SYSTEM = `You extract transactions from financial documents.

Return ONLY a JSON object: {"rows": [...], "meta": {...}}

Each row must have exactly these keys:
  date         string, as written in the document (do NOT reformat)
  amount       string, as written, including any sign, symbol or separators
  direction    "debit" | "credit" | null  (null if the sign or a Dr/Cr column implies it)
  description  string, the merchant/narration/particulars exactly as printed
  category     string | null
  account      string | null
  note         string | null
  currency     string | null
  payee        string | null
  page         number | null
  line         number | null

Rules:
- Preserve the document's own formatting. Never normalize dates or amounts;
  downstream code does that and needs the original to detect the format.
- Include EVERY transaction row. Skip balances, totals, subtotals, opening/closing
  balance lines, headers, footers, page numbers and advertising.
- If a column is a running balance, ignore it -- it is not a transaction amount.
- Do not invent rows. Do not merge rows. Two identical-looking rows are two rows.
- If the document has no transactions at all, return {"rows": [], "meta": {...}}.

meta must have:
  source_type   your best guess at the issuer, e.g. "HDFC Bank", "PhonePe",
                "Google Pay", "Money Manager export"
  day_first     true if dates appear to be dd/mm/yyyy (common in India), else false
  confidence    0..1, how readable the document was
  notes         anything ambiguous a human should check, or null`;

interface ExtractResponse {
  rows?: ExtractedRow[];
  meta?: {
    source_type?: string;
    day_first?: boolean;
    confidence?: number;
    notes?: string | null;
  };
}

export interface ExtractResult {
  rows: ExtractedRow[];
  meta: NonNullable<ExtractResponse['meta']>;
  usage: LlmUsage;
}

/**
 * Extract rows from a PDF (text or scanned).
 *
 * Gemini accepts the PDF inline and handles both cases with vision, so there is
 * no separate OCR step. For very large PDFs the model may truncate; `pageRange`
 * lets the caller chunk. Chunking is the caller's job because it knows the page
 * count and the user's remaining quota.
 */
export async function extractFromPdf(
  dataBase64: string,
  recordUsage: (usage: LlmUsage, fn: string) => Promise<void> | void,
  opts: { pageRange?: string; hint?: string } = {},
): Promise<ExtractResult> {
  const extra = [
    opts.pageRange ? `Only consider ${opts.pageRange}.` : '',
    opts.hint ? `Context from the user: ${opts.hint}` : '',
  ].filter(Boolean).join('\n');

  const { data, usage } = await completeJson<ExtractResponse>(
    {
      system: EXTRACT_SYSTEM,
      user: `Extract every transaction row from this document.\n${extra}`.trim(),
      inlineFile: { mimeType: 'application/pdf', dataBase64 },
      maxOutputTokens: 8192,
      temperature: 0,
    },
    recordUsage,
    'extract-pdf',
  );

  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    meta: data.meta ?? {},
    usage,
  };
}

/**
 * Extract rows from an image (a photographed receipt or a scanned page saved as
 * PNG/JPEG). Same contract as the PDF path.
 */
export async function extractFromImage(
  dataBase64: string,
  mimeType: string,
  recordUsage: (usage: LlmUsage, fn: string) => Promise<void> | void,
): Promise<ExtractResult> {
  const { data, usage } = await completeJson<ExtractResponse>(
    {
      system: EXTRACT_SYSTEM,
      user: 'Extract every transaction row from this image.',
      inlineFile: { mimeType, dataBase64 },
      maxOutputTokens: 8192,
      temperature: 0,
    },
    recordUsage,
    'extract-image',
  );

  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    meta: data.meta ?? {},
    usage,
  };
}

const SALVAGE_SYSTEM = `You turn raw pasted transaction text into structured rows.

Return ONLY a JSON object: {"rows": [...], "meta": {"day_first": bool, "confidence": 0..1, "notes": string|null}}

Each row: {date, amount, direction, description, note}
- date and amount exactly as written, never reformatted
- direction: "debit" | "credit" | null
- Skip totals, balances and headers. Include every actual transaction.`;

/**
 * Salvage rows from free text.
 *
 * Used when a file claimed to be CSV but `mapColumns()` could not find a date
 * and an amount -- e.g. the user pasted a WhatsApp expense list. This is a
 * genuine fallback, not the normal path.
 */
export async function rowsFromLlmText(
  text: string,
  recordUsage: (usage: LlmUsage, fn: string) => Promise<void> | void,
): Promise<ExtractResult> {
  // Cap the payload: models have context limits and a 10 MB paste is never going
  // to fit. The caller reports how much was dropped.
  const trimmed = text.length > 60_000 ? text.slice(0, 60_000) : text;

  const { data, usage } = await completeJson<ExtractResponse>(
    {
      system: SALVAGE_SYSTEM,
      user: `Raw text:\n"""\n${trimmed}\n"""`,
      maxOutputTokens: 8192,
      temperature: 0,
    },
    recordUsage,
    'extract-text',
  );

  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    meta: data.meta ?? {},
    usage,
  };
}
