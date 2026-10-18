/**
 * Display formatting.
 *
 * Every money value in the database is `numeric(14,2)` stored as a POSITIVE
 * magnitude, with the sign living in `transactions.direction`. That is a
 * deliberate schema choice — it makes `sum(amount)` and `avg(amount)` behave —
 * but it means the UI must never print a raw amount without deciding the sign
 * first. Use `signedAmount()` for that.
 */

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const INR_EXACT = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const PLAIN = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** Supabase returns `numeric` as a string. Coerce defensively. */
export function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Indian-locale rupees, rounded: ₹18,294.
 *
 * `en-IN` matters here — it groups as 1,00,000 rather than 100,000, which is
 * how the numbers in this app will actually be read.
 */
export function money(value: unknown): string {
  return INR.format(num(value));
}

/** Rupees with paise, for per-transaction amounts: ₹542.00. */
export function moneyExact(value: unknown): string {
  return INR_EXACT.format(num(value));
}

/** A bare number with Indian grouping, no symbol: 1,897. */
export function count(value: unknown): string {
  return PLAIN.format(num(value));
}

/** Compact rupees for chart axes and dense tables: ₹26.6K, ₹1.2L, ₹3.4Cr. */
export function moneyCompact(value: unknown): string {
  const n = num(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Apply the direction. Credits are positive, debits negative. */
export function signedAmount(amount: unknown, direction: string | null | undefined): number {
  const magnitude = num(amount);
  return direction === "credit" ? magnitude : -magnitude;
}

export function percent(value: unknown, digits = 0): string {
  const n = num(value);
  return `${n.toFixed(digits)}%`;
}

const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" });
const DAY = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const TIME = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});
const SHORT_MONTH = new Intl.DateTimeFormat("en-IN", { month: "short" });

/**
 * Parse a date-only string as a LOCAL date.
 *
 * `new Date("2026-06-01")` is specified to parse as UTC midnight, so in any
 * timezone behind UTC it lands on 2026-05-31 and every month label, chart axis
 * and "first seen" date is off by one month on the boundary. The database stores
 * `date` columns as bare `YYYY-MM-DD` with no zone, which means "this calendar
 * day" — so it has to be built from its parts.
 *
 * Timestamps (`occurred_at`, `created_at`) carry a zone and are parsed normally.
 */
function toLocalDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}

/** `2026-06-01` -> "Jun 2026". Month views are labelled this way. */
export function monthLabel(month: string | Date): string {
  return MONTH.format(toLocalDate(month));
}

/** `2026-06-01` -> "Jun ’26". For chart axes, where "Jun 2026" is too wide. */
export function shortMonth(month: string | Date): string {
  const d = toLocalDate(month);
  return `${SHORT_MONTH.format(d)} ’${String(d.getFullYear()).slice(2)}`;
}

export function dateLabel(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return DAY.format(toLocalDate(value));
}

export function dateTimeLabel(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return TIME.format(toLocalDate(value));
}

/** "3 months ago" — for documents and insights. */
export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const then = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((then.getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, "second");
}

/**
 * Confidence as a label. The thresholds mirror the ingest function: 0.85 and
 * above is auto-accepted, below it the row goes to the review queue. Showing
 * the same bands in the UI keeps "why is this in review?" answerable at a glance.
 */
export function confidenceLabel(value: unknown): { label: string; tone: Tone } {
  const c = num(value);
  if (c <= 0) return { label: "no match", tone: "danger" };
  if (c >= 0.95) return { label: "certain", tone: "success" };
  if (c >= 0.85) return { label: "confident", tone: "success" };
  if (c >= 0.6) return { label: "likely", tone: "warning" };
  return { label: "guess", tone: "danger" };
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** Sentence-case a snake_case slug: `food_out` -> "Food out". */
export function humanize(slug: string | null | undefined): string {
  if (!slug) return "—";
  const spaced = slug.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** First `n` characters, on a word boundary, with an ellipsis. */
export function truncate(text: string | null | undefined, max = 60): string {
  if (!text) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}…`;
}
