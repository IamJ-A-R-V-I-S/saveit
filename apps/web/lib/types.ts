/**
 * Types mirroring the database schema.
 *
 * These are hand-written rather than generated because the schema is small and
 * stable, and because the `numeric(14,2)` columns arrive as STRINGS over
 * PostgREST — a codegen tool would type them `number` and every sum would
 * silently concatenate. Anything money-shaped is `string | number` and goes
 * through `num()` in lib/format.ts before arithmetic.
 */

export type AccountKind =
  | "bank"
  | "cash"
  | "wallet"
  | "credit_card"
  | "upi"
  | "investment"
  | "savings"
  | "other";

export type DocumentKind = "csv" | "xlsx" | "pdf" | "json" | "other";

export type DocumentStatus = "uploaded" | "parsing" | "parsed" | "failed" | "needs_review";

export type CategorizeStatus = "pending" | "auto" | "review" | "corrected" | "skipped";

export type Direction = "debit" | "credit";

export type InsightKind = "opportunity" | "anomaly" | "goal_progress" | "summary";

export type InsightStatus = "new" | "seen" | "dismissed" | "accepted" | "acted_on";

export type ProductStatus = "active" | "merged" | "archived";

export type GoalStatus = "active" | "reached" | "cancelled";

export type BudgetPeriod = "weekly" | "monthly" | "quarterly" | "yearly";

/** `numeric` over the wire. Always coerce with `num()` before doing math. */
export type Numeric = string | number | null;

export interface Sector {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  sort_order: number;
  is_system: boolean;
}

export interface Product {
  id: string;
  sector_id: string;
  name: string;
  normalized_name: string;
  status: ProductStatus;
  use_count: number;
  is_seeded: boolean;
  merged_into: string | null;
  sector?: Pick<Sector, "slug" | "name" | "icon"> | null;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  institution: string | null;
  currency: string;
  manual_only: boolean;
  is_archived: boolean;
}

export interface DocumentRow {
  id: string;
  filename: string;
  kind: DocumentKind;
  source_type: string | null;
  status: DocumentStatus;
  storage_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
  row_count: number | null;
  imported_count: number | null;
  duplicate_count: number | null;
  error_message: string | null;
  period_start: string | null;
  period_end: string | null;
  coverage: Coverage | null;
  created_at: string;
  account_id: string | null;
}

/** `documents.coverage`, written by the ingest function. */
export interface Coverage {
  resolvedFree?: number;
  needsLlm?: number;
  exact?: number;
  alias?: number;
  keyword?: number;
  none?: number;
  [key: string]: unknown;
}

export interface Transaction {
  id: string;
  account_id: string;
  document_id: string | null;
  product_id: string | null;
  amount: Numeric;
  direction: Direction;
  currency: string;
  occurred_at: string;
  raw_description: string | null;
  note: string | null;
  payee: string | null;
  categorize_status: CategorizeStatus;
  confidence: Numeric;
  categorize_reason: string | null;
  llm_model: string | null;
  is_recurring: boolean;
  created_at: string;
  account?: Pick<Account, "name" | "kind"> | null;
  product?: (Pick<Product, "name" | "id"> & { sector?: Pick<Sector, "slug" | "name" | "icon"> | null }) | null;
}

export interface Insight {
  id: string;
  period_start: string | null;
  period_end: string | null;
  kind: InsightKind;
  rank: number | null;
  sector_id: string | null;
  product_id: string | null;
  headline: string;
  detail: string | null;
  monthly_saving_estimate: Numeric;
  confidence: Numeric;
  evidence: EvidenceItem[];
  status: InsightStatus;
  llm_model: string | null;
  created_at: string;
  sector?: Pick<Sector, "slug" | "name" | "icon"> | null;
  product?: Pick<Product, "name"> | null;
}

/**
 * One entry in `insights.evidence`.
 *
 * The coach was specified to return "ranked savings opportunities with rupee
 * estimates plus the exact transactions behind them" — this is that proof, so a
 * user can check a claim rather than take it on faith.
 */
export interface EvidenceItem {
  id?: string;
  occurred_at?: string;
  amount?: Numeric;
  description?: string;
  [key: string]: unknown;
}

export interface BudgetStatus {
  id: string;
  sector_id: string;
  sector_slug: string;
  sector_name: string;
  sector_icon: string | null;
  period: BudgetPeriod;
  budget_amount: Numeric;
  actual_spend: Numeric;
  tx_count: number;
  pct_used: Numeric;
  remaining: Numeric;
}

export interface GoalStatusRow {
  id: string;
  name: string;
  target_amount: Numeric;
  saved_amount: Numeric;
  deadline: string | null;
  status: GoalStatus;
  pct_complete: Numeric;
  remaining: Numeric;
  days_left: number | null;
  required_daily_saving: Numeric;
}

/** One row of `v_dashboard_summary`. */
export interface DashboardSummary {
  user_id: string;
  total_transactions: number;
  total_spend: Numeric;
  total_income: Numeric;
  first_transaction: string | null;
  last_transaction: string | null;
  needs_review: number;
  product_count: number;
  document_count: number;
}

/** One row of `v_monthly_coverage`. */
export interface MonthlyCoverage {
  month: string;
  tx_count: number;
  total_spend: Numeric;
  total_income: Numeric;
  needs_review: number;
  pending: number;
  uncategorized: number;
  categorize_pct: Numeric;
}

/** One row of `v_monthly_sector_spend`. */
export interface MonthlySectorSpend {
  month: string;
  sector_id: string;
  sector_slug: string;
  sector_name: string;
  sector_icon: string | null;
  spend: Numeric;
  tx_count: number;
}

/** One row of `v_monthly_product_spend`. */
export interface MonthlyProductSpend {
  month: string;
  product_id: string;
  product_name: string;
  sector_id: string;
  sector_slug: string;
  sector_name: string;
  spend: Numeric;
  tx_count: number;
  avg_ticket: Numeric;
}

/** Response of the `ingest` edge function. */
export interface IngestResult {
  documentId: string;
  kind: DocumentKind;
  sourceType: string | null;
  rowCount: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  skippedSamples?: string[];
  resolvedWithoutLlm: number;
  needsReview: number;
  pendingCategorization: number;
  taxonomySeeded: boolean;
  productsSeeded: number;
  llmCallsUsed: number;
  period: { start: string; end: string };
  coverage?: Coverage;
}

/** Response of the `coach` edge function. */
export interface CoachResult {
  insights: number;
  opportunities: CoachOpportunity[];
  window: { start: string; end: string };
  months: number;
  pushed?: boolean;
  llmCallsUsed?: number;
}

export interface CoachOpportunity {
  rank?: number;
  headline?: string;
  detail?: string;
  monthlySavingEstimate?: Numeric;
  confidence?: Numeric;
  sector?: string | null;
  product?: string | null;
  txCount?: number;
  spend?: Numeric;
  evidenceCount?: number;
}

/** Response of the `correct` edge function. */
export interface CorrectResult {
  updated: number;
  appliedToSimilar: number;
  aliasesWritten: string[];
  productId: string;
  productName: string;
}

export interface ProfileRow {
  id: string;
  email: string | null;
  full_name: string | null;
  default_currency: string;
  telegram_chat_id: string | null;
  telegram_enabled: boolean;
  llm_daily_cap: number;
  onboarded: boolean;
}
