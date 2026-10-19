/**
 * Barrel for the shared edge-function modules.
 *
 * Deno edge functions resolve relative imports at deploy time, so a single
 * import site keeps the function bodies readable and stops the same symbol being
 * pulled from two different paths.
 */

export {
  canonicalAccountName,
  isCashAccount,
  sameAccount,
} from './accounts.ts';

export {
  assertQuota,
  corsHeaders,
  ensureAccount,
  ensureProduct,
  fail,
  json,
  llmCallsToday,
  loadTaxonomy,
  recordLlmUsage,
  serviceClient,
  userClient,
  userIdFromRequest,
} from './db.ts';

export {
  buildTaxonomy,
  buildTaxonomyBrief,
  findNearDuplicates,
  resolveDeterministic,
  type Resolution,
  type Taxonomy,
} from './taxonomy.ts';

export {
  canonicalProductName,
  guessSectorFromKeywords,
  KEYWORD_SECTOR_RULES,
  normalizeProductName,
  SECTOR_PRODUCTS,
} from './taxonomy-seed.ts';

export {
  assignOccurrences,
  formatAmount,
  formatTimestampUtc,
  groupByAccount,
  makeDedupKey,
  normalizeDescription,
  sha256Hex,
  stageRow,
  type ColumnValues,
  type DedupKeyInput,
} from './normalize.ts';

export {
  detectDelimiter,
  detectHeaderRow,
  isUsableMap,
  mapColumns,
  parseAmount,
  parseDate,
  parseDelimited,
  parseDirection,
} from './parse.ts';

export {
  complete,
  completeJson,
  extractJson,
  LlmError,
  QuotaExceededError,
  resolveProvider,
  type CompleteOptions,
  type CompleteResult,
  type Provider,
} from './llm.ts';

export {
  extractFromImage,
  extractFromPdf,
  rowsFromLlmText,
  type ExtractedRow,
  type ExtractResult,
} from './extract.ts';

export { seedTaxonomyIfEmpty, type SeedResult } from './seed.ts';

export type {
  Alias,
  CategorizeResult,
  CategorizeStatus,
  Direction,
  DocumentKind,
  HeaderMap,
  LlmUsage,
  Opportunity,
  Product,
  Sector,
  StagedRow,
} from './types.ts';
