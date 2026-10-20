/**
 * Shared types for the SaveIt edge functions.
 *
 * These mirror the Postgres schema in supabase/migrations/. Keep them in sync
 * when a migration changes a column.
 */

export type Direction = 'debit' | 'credit';

export type DocumentKind = 'csv' | 'xlsx' | 'pdf' | 'json' | 'other';

export type CategorizeStatus =
  | 'pending'
  | 'auto'
  | 'review'
  | 'corrected'
  | 'skipped';

/** A row extracted from any document, before it is deduped or categorized. */
export interface StagedRow {
  occurredAt: Date;
  amount: number;          // always a positive magnitude
  direction: Direction;
  currency: string;
  rawDescription: string;  // the string the categorizer will read
  note?: string | null;
  payee?: string | null;
  /** Which column produced which field, kept for debugging the header map. */
  sourceRef: Record<string, unknown>;
}

/**
 * Which physical column plays which logical role. This is the deterministic
 * half of ingestion -- no LLM call should ever be needed to discover it.
 */
export interface HeaderMap {
  date?: number;
  amount?: number;
  debit?: number;
  credit?: number;
  direction?: number;
  description?: number;
  category?: number;
  account?: number;
  note?: number;
  currency?: number;
  payee?: number;
  /** Columns that look like a description but were not the primary match. */
  extraDescription?: number[];
  confidence: number;
  unmapped: string[];
}

export interface Sector {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
}

export interface Product {
  id: string;
  sectorId: string;
  name: string;
  normalizedName: string;
  /** How often this product has been used. Drives brief ordering. */
  useCount: number;
}

export interface Alias {
  id: string;
  productId: string;
  pattern: string;
  patternType: 'exact' | 'contains' | 'regex';
  confidence: number;
}

/** What the categorization LLM must return. Strict JSON, no prose. */
export interface CategorizeResult {
  product: string;
  sector: string;
  confidence: number;
  reason: string;
  /** Set when the model believes this is a brand-new product worth keeping. */
  isNewProduct?: boolean;
}

export interface LlmUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/** A single savings opportunity produced by the Coach. */
export interface Opportunity {
  headline: string;
  detail: string;
  sectorSlug: string | null;
  productName: string | null;
  monthlySavingEstimate: number | null;
  confidence: number;
  /** Transaction ids that back the claim. No unsourced advice. */
  evidence: string[];
}
