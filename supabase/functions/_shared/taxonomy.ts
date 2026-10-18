/**
 * Taxonomy resolution.
 *
 * The order of operations here is the whole cost story:
 *
 *   1. exact normalized-name match against the user's products   (free)
 *   2. learned alias rules, longest pattern first                (free)
 *   3. keyword priors from taxonomy-seed.ts                      (free)
 *   4. only what survives all three goes to the LLM              (paid)
 *
 * Every correction the user makes writes an alias, so step 2 gets stronger over
 * time and step 4 gets called less. On the sample file the first three steps
 * resolve the large majority of rows without a single token.
 */

import type { Alias, Product, Sector } from './types.ts';
import { guessSectorFromKeywords, normalizeProductName } from './taxonomy-seed.ts';

export interface Taxonomy {
  sectors: Sector[];
  products: Product[];
  aliases: Alias[];
  /** normalized product name -> product, for O(1) exact lookup. */
  byNormalizedName: Map<string, Product>;
  sectorBySlug: Map<string, Sector>;
}

export function buildTaxonomy(
  sectors: Sector[],
  products: Product[],
  aliases: Alias[],
): Taxonomy {
  const byNormalizedName = new Map<string, Product>();
  for (const p of products) byNormalizedName.set(p.normalizedName, p);

  const sectorBySlug = new Map<string, Sector>();
  for (const s of sectors) sectorBySlug.set(s.slug, s);

  return { sectors, products, aliases, byNormalizedName, sectorBySlug };
}

export interface Resolution {
  product: Product | null;
  sectorSlug: string | null;
  confidence: number;
  /** Which step resolved it. 'alias' and 'exact' cost nothing. */
  via: 'exact' | 'alias' | 'keyword' | 'none';
  /**
   * True when the match landed in the `uncategorized` sector.
   *
   * An exact name match is normally enough to auto-accept, but not here:
   * "Charges, Fees" is seeded into `uncategorized` precisely because the real
   * data shows it covering exam fees, brokerage, a maid and a freelancer
   * payment. Matching it confidently would file all four under one wrong sector
   * and never surface them. These rows go to the review queue even at
   * confidence 0.99, because the *note* -- not the category -- decides.
   */
  needsReview: boolean;
  aliasId?: string;
}

/**
 * Resolve a description to a product without calling the model.
 *
 * Returns via:'none' when nothing matched -- the caller then batches the row
 * into an LLM request.
 */
export function resolveDeterministic(tax: Taxonomy, description: string): Resolution {
  const raw = description.trim();
  if (!raw) {
    return { product: null, sectorSlug: null, confidence: 0, via: 'none', needsReview: true };
  }

  // 1. Exact match on the normalized name.
  //    A tracker export puts the product name first in the synthesized
  //    description ("Cha | Cold coffee at keventers"), so check the leading
  //    segment as well as the whole string.
  const segments = raw.split('|').map((s) => s.trim()).filter(Boolean);
  const candidates = [raw, ...segments];
  for (const c of candidates) {
    const hit = tax.byNormalizedName.get(normalizeProductName(c));
    if (hit) {
      const sector = tax.sectors.find((s) => s.id === hit.sectorId);
      return {
        product: hit,
        sectorSlug: sector?.slug ?? null,
        confidence: 0.99,
        via: 'exact',
        needsReview: sector?.slug === 'uncategorized',
      };
    }
  }

  // 2. Learned aliases. Longest pattern first so a specific rule
  //    ("cold coffee at keventers") beats a generic one ("coffee").
  const lowered = raw.toLowerCase();
  const sorted = [...tax.aliases].sort((a, b) => b.pattern.length - a.pattern.length);
  for (const alias of sorted) {
    let matched = false;
    try {
      switch (alias.patternType) {
        case 'exact':
          matched = lowered === alias.pattern.toLowerCase();
          break;
        case 'regex':
          matched = new RegExp(alias.pattern, 'i').test(raw);
          break;
        case 'contains':
        default:
          matched = lowered.includes(alias.pattern.toLowerCase());
          break;
      }
    } catch {
      // A user-supplied regex can be invalid. Skip it rather than aborting the
      // whole batch -- one bad rule must not break ingestion.
      continue;
    }
    if (!matched) continue;

    const product = tax.products.find((p) => p.id === alias.productId) ?? null;
    if (!product) continue;
    const sector = tax.sectors.find((s) => s.id === product.sectorId);
    return {
      product,
      sectorSlug: sector?.slug ?? null,
      confidence: Number(alias.confidence),
      via: 'alias',
      needsReview: sector?.slug === 'uncategorized',
      aliasId: alias.id,
    };
  }

  // 3. Keyword prior. This gives a SECTOR but not a product, so it is a hint for
  //    the model rather than a final answer -- hence the modest confidence.
  const sectorSlug = guessSectorFromKeywords(raw);
  if (sectorSlug) {
    return { product: null, sectorSlug, confidence: 0.4, via: 'keyword', needsReview: true };
  }

  return { product: null, sectorSlug: null, confidence: 0, via: 'none', needsReview: true };
}

/**
 * Build the compact taxonomy brief that goes into the categorization prompt.
 *
 * Deliberately NOT the full product list: with 147 products and their aliases
 * that is thousands of tokens per call, multiplied by every batch. Instead we
 * send sector names plus the products in the sectors the keyword priors
 * suggested, capped. The model can still name a product outside the brief --
 * we just do not pay to list all of them every time.
 */
export function buildTaxonomyBrief(
  tax: Taxonomy,
  hintSlugs: string[],
  maxProducts = 60,
): string {
  const lines: string[] = ['SECTORS:'];
  for (const s of tax.sectors) {
    if (s.slug === 'uncategorized') continue;
    lines.push(`- ${s.slug}: ${s.name}`);
  }

  const hinted = new Set(hintSlugs);
  const chosen = tax.products.filter((p) => {
    const s = tax.sectors.find((x) => x.id === p.sectorId);
    return s ? hinted.has(s.slug) : false;
  });

  // Most-used products first. This is the point of maintaining use_count
  // (migration 0008): listing what the user actually buys most makes the model
  // reuse an existing name instead of inventing a near-duplicate.
  const ranked = chosen
    .sort((a, b) => b.useCount - a.useCount || a.name.localeCompare(b.name))
    .slice(0, maxProducts);
  if (ranked.length > 0) {
    lines.push('', 'EXISTING PRODUCTS in the likely sectors (reuse these names exactly):');
    for (const p of ranked) {
      const s = tax.sectors.find((x) => x.id === p.sectorId);
      lines.push(`- ${p.name} [${s?.slug ?? 'uncategorized'}]`);
    }
  }

  return lines.join('\n');
}

/**
 * Find products that are probably the same thing, for the merge queue.
 *
 * The hybrid taxonomy lets the model create products, so duplicates are
 * inevitable ("Idli sambar" vs "Idli-sambar"). Detecting them cheaply keeps the
 * taxonomy from sprawling -- the main risk the user was warned about.
 */
export function findNearDuplicates(
  products: Array<Pick<Product, 'id' | 'name' | 'useCount' | 'sectorId'>>,
): Array<{ keep: string; drop: string; reason: string }> {
  const out: Array<{ keep: string; drop: string; reason: string }> = [];
  const byKey = new Map<string, Array<Pick<Product, 'id' | 'name' | 'useCount' | 'sectorId'>>>();

  for (const p of products) {
    // Compare on a aggressively folded key: no punctuation, no spaces.
    const key = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(p);
    else byKey.set(key, [p]);
  }

  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    // Keep the one with more history so merging preserves the dominant name.
    const sortedBucket = [...bucket].sort((a, b) => b.useCount - a.useCount);
    for (let i = 1; i < sortedBucket.length; i++) {
      out.push({
        keep: sortedBucket[0].id,
        drop: sortedBucket[i].id,
        reason: `"${sortedBucket[i].name}" is identical to "${sortedBucket[0].name}" ` +
          'once punctuation and case are ignored',
      });
    }
  }
  return out;
}
