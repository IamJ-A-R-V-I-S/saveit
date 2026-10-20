/**
 * Deterministic document parsing.
 *
 * This module exists so that the LLM is NEVER called to read a CSV. Column
 * discovery is a solved, rule-based problem: match header names against known
 * aliases. Sending 5,000 rows to a model to find the "amount" column would be
 * slow, expensive and less reliable than the code below.
 *
 * The LLM is reserved for two things only:
 *   1. extracting rows from genuinely unstructured documents (PDFs), and
 *   2. categorizing a row once it exists.
 */

import type { HeaderMap } from './types.ts';

// ---------------------------------------------------------------------------
// delimiter detection
// ---------------------------------------------------------------------------

const CANDIDATE_DELIMITERS = [';', ',', '\t', '|'];

/**
 * Pick the delimiter that produces the most consistent column count.
 *
 * Counting occurrences on line 1 is not enough: the sample statement uses `;`
 * as the delimiter but `,` appears inside values ("Loan, interests",
 * "Clothes & shoes"). Consistency across lines is what disambiguates.
 */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64_000).split('\n').slice(0, 40).filter((l) => l.trim());
  if (sample.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const delim of CANDIDATE_DELIMITERS) {
    const counts = sample.map((line) => countFields(line, delim));
    const first = counts[0];
    if (first < 2) continue;

    // Score = how many lines agree with the header's column count. A delimiter
    // that appears inside quoted values will disagree on most lines.
    const agreeing = counts.filter((c) => c === first).length;
    const score = (agreeing / counts.length) * 100 + Math.min(first, 20);

    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

/** Count unquoted delimiter-separated fields on one line. */
function countFields(line: string, delim: string): number {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // "" inside a quoted field is an escaped quote, not a toggle.
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// CSV parsing (state machine -- handles quoted fields spanning multiple lines)
// ---------------------------------------------------------------------------

/**
 * Parse delimited text into rows.
 *
 * A naive `split('\n')` would corrupt the sample file, which contains notes
 * with embedded newlines inside quotes:
 *   "Ayantika -> Me : Gpay (sixer) \n$3922 to go"
 * This is a proper state machine over the whole buffer.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM, which would otherwise corrupt the first header name.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // handled together with the following \n
    } else {
      field += ch;
    }
  }

  // Flush the final field/row if the file did not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---------------------------------------------------------------------------
// header row detection
// ---------------------------------------------------------------------------

/**
 * Find the header row. Bank CSVs frequently carry preamble ("Account
 * Statement", "Period: ...", blank lines) above the real header, so the header
 * is not always row 0.
 */
export function detectHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 30);
  let best = 0;
  let bestScore = -1;

  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map((c) => c.trim());
    const nonEmpty = cells.filter(Boolean).length;
    if (nonEmpty < 2) continue;

    let score = 0;
    for (const cell of cells) {
      const key = normalizeHeader(cell);
      if (ROLE_PATTERNS.some((role) => role.patterns.includes(key))) score += 3;
      else if (/^[a-z][a-z0-9 _\/\-().]{0,40}$/.test(key)) score += 1;
    }
    // Penalise rows that look like data (mostly numeric).
    const numeric = cells.filter((c) => /^-?[\d.,]+\s*$/.test(c.trim())).length;
    score -= numeric * 2;

    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\ufeff/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// column role mapping
// ---------------------------------------------------------------------------

interface RoleDef {
  role: keyof Omit<HeaderMap, 'confidence' | 'unmapped' | 'extraDescription'>;
  patterns: string[];
}

/**
 * Known header names per logical role, most specific first.
 *
 * These came from real statement exports plus the sample tracker file, whose
 * columns are: account, category, currency, amount, ref_currency_amount, type,
 * payment_type, note, date, gps_*, warranty_in_month, transfer, payee,
 * labels, envelope_id, custom_category.
 */
const ROLE_PATTERNS: RoleDef[] = [
  {
    role: 'date',
    patterns: [
      'date', 'txn date', 'transaction date', 'value date', 'posted date',
      'posting date', 'booking date', 'time', 'timestamp', 'datetime',
      'date time', 'transaction time', 'entry date',
    ],
  },
  {
    role: 'debit',
    patterns: ['debit', 'withdrawals', 'withdrawal', 'dr'],
  },
  {
    role: 'credit',
    patterns: ['credit', 'deposits', 'deposit', 'cr'],
  },
  {
    role: 'amount',
    patterns: [
      'amount', 'amt', 'transaction amount', 'txn amount', 'value',
      'amount inr', 'amount in', 'transaction value', 'sum', 'total',
      'amount ref currency', 'ref currency amount', 'debit', 'withdrawal',
      'deposit', 'credit amount', 'debit amount',
    ],
  },
  {
    role: 'direction',
    patterns: [
      'type', 'transaction type', 'txn type', 'dr cr', 'dr or cr', 'drc',
      'direction', 'debit credit', 'cr dr', 'chq type', 'transaction type dr cr',
    ],
  },
  {
    role: 'description',
    patterns: [
      'description', 'narration', 'particulars', 'details', 'detail',
      'remarks', 'transaction details', 'transaction remarks', 'merchant',
      'merchant name', 'payee name', 'beneficiary', 'beneficiary name',
      'transaction description', 'info', 'reference', 'utr', 'txn id',
      'description of transaction',
    ],
  },
  { role: 'category', patterns: ['category', 'subcategory', 'sub category', 'envelope', 'envelope id', 'tag', 'tags'] },
  { role: 'account', patterns: ['account', 'account name', 'account no', 'source', 'source account', 'wallet', 'card'] },
  { role: 'note', patterns: ['note', 'notes', 'comment', 'comments', 'memo', 'label', 'labels'] },
  { role: 'currency', patterns: ['currency', 'ccy', 'currency code', 'amount currency'] },
  { role: 'payee', patterns: ['payee', 'payee name', 'beneficiary', 'to', 'receiver', 'person'] },
];

/** Map a header row onto logical column roles. Pure rules, no model call. */
export function mapColumns(header: string[]): HeaderMap {
  const keys = header.map(normalizeHeader);
  const map: HeaderMap = { confidence: 0, unmapped: [] };
  const claimed = new Set<number>();

  // Pass 1: exact matches, in role priority order. date/amount/direction are
  // claimed before description so that "transaction date" cannot be stolen by
  // the description role's looser patterns.
  for (const def of ROLE_PATTERNS) {
    for (const pattern of def.patterns) {
      const idx = keys.findIndex((k, i) => k === pattern && !claimed.has(i));
      if (idx === -1) continue;
      if (map[def.role] === undefined) {
        map[def.role] = idx;
        claimed.add(idx);
      } else if (def.role === 'description') {
        (map.extraDescription ??= []).push(idx);
        claimed.add(idx);
      }
    }
  }

  // Pass 2: substring matches for anything still unclaimed. "Amount (INR)"
  // normalizes to "amount inr" which exact-matched above, but oddities like
  // "withdrawal amount dr" only resolve here.
  for (const def of ROLE_PATTERNS) {
    if (map[def.role] !== undefined) continue;
    for (const pattern of def.patterns) {
      const idx = keys.findIndex(
        (k, i) => !claimed.has(i) && k.length > 2 && k.includes(pattern),
      );
      if (idx === -1) continue;
      map[def.role] = idx;
      claimed.add(idx);
      break;
    }
  }

  map.unmapped = keys.filter((_, i) => !claimed.has(i) && keys[i]);

  // Confidence: the three fields we cannot work without are date, amount and
  // some description. Weight them accordingly.
  let score = 0;
  if (map.date !== undefined) score += 0.4;
  if (map.amount !== undefined) score += 0.4;
  if (map.description !== undefined || map.category !== undefined) score += 0.1;
  if (map.direction !== undefined) score += 0.05;
  if (map.account !== undefined) score += 0.05;
  map.confidence = Math.round(score * 100) / 100;

  return map;
}

/**
 * Is this header map good enough to ingest without asking the model?
 *
 * Without a date and an amount the rows are meaningless. Description is
 * required for categorization but can be synthesized from `category` when the
 * file is a tracker export rather than a bank statement -- which is exactly the
 * case for the sample, where `category` is the product-level label.
 */
export function isUsableMap(map: HeaderMap): boolean {
  return map.date !== undefined
    && (map.amount !== undefined || map.debit !== undefined || map.credit !== undefined)
    && (map.description !== undefined || map.category !== undefined);
}

// ---------------------------------------------------------------------------
// value coercion
// ---------------------------------------------------------------------------

/**
 * Parse a monetary value from any common format.
 *
 * Handles: "1,234.56"  "-1,234.56"  "1.234,56" (Indian/European grouping)
 * "₹1,234"  "(1,234.00)" (accounting negative)  "1 234,56".
 * Returns the magnitude plus whether the source signalled a debit.
 */
export function parseAmount(raw: string): { amount: number; negative: boolean } | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  // Accounting convention: parentheses mean negative.
  let negative = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    negative = true;
    s = paren[1].trim();
  }

  // Strip currency symbols, codes and spacing.
  s = s.replace(/[₹$€£¥]/g, '').replace(/\b(inr|usd|eur|gbp)\b/gi, '').replace(/\s+/g, '');

  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  // Decide the decimal separator. If both . and , appear, the LAST one is the
  // decimal separator ("1,234.56" -> . ; "1.234,56" -> ,).
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot > -1 && lastComma > -1) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    // A lone comma with exactly two trailing digits is a decimal separator;
    // otherwise it is a thousands separator.
    const tail = s.slice(lastComma + 1);
    s = /^\d{1,2}$/.test(tail) && s.length - lastComma <= 4
      ? s.replace(',', '.')
      : s.replace(/,/g, '');
  } else {
    s = s.replace(/,/g, '');
  }

  s = s.replace(/[^0-9.]/g, '');
  const value = Number.parseFloat(s);
  if (!Number.isFinite(value)) return null;

  return { amount: Math.abs(value), negative };
}

/** Direction keywords used by bank statements that carry a Dr/Cr column. */
const DEBIT_WORDS = ['dr', 'debit', 'withdrawal', 'withdrawn', 'paid', 'payment', 'expense', 'expenses', 'out', 'outflow', 'spent'];
const CREDIT_WORDS = ['cr', 'credit', 'deposit', 'deposited', 'received', 'income', 'in', 'inflow', 'refund', 'reversal'];

export function parseDirection(raw: string | undefined): 'debit' | 'credit' | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (!k) return null;
  // Exact tokens first: "dr" must not be matched as a prefix of "drinks".
  if (DEBIT_WORDS.includes(k)) return 'debit';
  if (CREDIT_WORDS.includes(k)) return 'credit';
  if (k.startsWith('debit') || k.startsWith('withdraw') || k.startsWith('expense')) return 'debit';
  if (k.startsWith('credit') || k.startsWith('deposit') || k.startsWith('income')) return 'credit';
  return null;
}

const DATE_FORMATS = [
  // ISO with time
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/, order: [1, 2, 3] },
  // ISO date only
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: [1, 2, 3] },
  // dd/mm/yyyy or dd-mm-yyyy (common in Indian statements)
  { re: /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/, order: [1, 2, 3] },
];

/**
 * Parse a date from any format seen in real statements.
 *
 * The dd/mm vs mm/dd ambiguity is resolved by `dayFirst`, which the caller sets
 * from the document's locale (Indian bank statements are day-first). When a
 * component exceeds 12 the ambiguity disappears and that row is authoritative.
 */
export function parseDate(raw: string, dayFirst = true): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  for (const fmt of DATE_FORMATS) {
    const m = s.match(fmt.re);
    if (!m) continue;

    let a = Number.parseInt(m[1], 10);
    let b = Number.parseInt(m[2], 10);
    let year = Number.parseInt(m[3], 10);
    if (year < 100) year += year < 70 ? 2000 : 1900;

    let day: number;
    let month: number;
    if (fmt.order[0] === 1 && m[3].length === 4 && /^(\d{4})-/.test(s)) {
      // ISO: yyyy-mm-dd
      month = a;
      day = b;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (dayFirst) {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }

    const hour = m[4] ? Number.parseInt(m[4], 10) : 0;
    const minute = m[5] ? Number.parseInt(m[5], 10) : 0;
    const second = m[6] ? Number.parseInt(m[6], 10) : 0;

    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (Number.isNaN(d.getTime())) continue;
    // Reject rollover (e.g. 31 February silently becomes 3 March).
    if (d.getUTCDate() !== day || d.getUTCMonth() !== month - 1) continue;
    return d;
  }

  const fallback = Date.parse(s);
  return Number.isNaN(fallback) ? null : new Date(fallback);
}
