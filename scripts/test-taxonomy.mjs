/**
 * Taxonomy unit tests.
 *
 * Covers name canonicalization, the keyword priors, the deterministic resolver
 * (which is what keeps LLM costs near zero), near-duplicate detection, and
 * coverage of the seed list against the real category vocabulary.
 *
 * Run:  node --experimental-strip-types scripts/test-taxonomy.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalProductName, normalizeProductName, guessSectorFromKeywords,
  SECTOR_PRODUCTS,
} from '../supabase/functions/_shared/taxonomy-seed.ts';
import {
  buildTaxonomy, buildTaxonomyBrief, findNearDuplicates, resolveDeterministic,
} from '../supabase/functions/_shared/taxonomy.ts';

const here = dirname(fileURLToPath(import.meta.url));

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${name}`);
  else { fails++; console.log(`  FAIL ${name}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
};
const truthy = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fails++; console.log(`  FAIL ${name} ${detail}`); }
};

// ---------------------------------------------------------------------------
console.log('canonicalProductName');
eq('lowercases to sentence case', canonicalProductName('guava'), 'Guava');
eq('strips emoji', canonicalProductName('Eggs 🥚'), 'Eggs');
eq('fixes Chanachur0 typo', canonicalProductName('Chanachur0'), 'Chanachur');
eq('fixes case-only name', canonicalProductName('BREAKFAST'), 'Breakfast');
eq('unifies Idli spellings', canonicalProductName('Idli sambar'), 'Idli-sambar');
eq('keeps punctuation that is part of the name', canonicalProductName('Clothes & shoes'), 'Clothes & shoes');
eq('emoji-only becomes Unknown', canonicalProductName('👖'), 'Unknown');
eq('emoji-only shirt becomes Unknown', canonicalProductName('👕'), 'Unknown');
eq('empty stays empty', canonicalProductName('   '), '');

console.log('normalizeProductName');
eq('folds punctuation', normalizeProductName('Idli-sambar'), normalizeProductName('Idli sambar'));
eq('folds emoji + case', normalizeProductName('Eggs 🥚'), normalizeProductName('eggs'));
eq('emoji-only folds to unknown', normalizeProductName('👖'), 'unknown');

console.log('guessSectorFromKeywords (merchant priors for bank statements)');
eq('UBER', guessSectorFromKeywords('UBER *TRIP HELP.UBER.COM'), 'transport');
eq('BLINKIT', guessSectorFromKeywords('BLINKIT COM PRIVATE LTD'), 'groceries');
eq('AIRTEL', guessSectorFromKeywords('AIRTEL RECHARGE 199'), 'telecom');
eq('SALARY', guessSectorFromKeywords('SALARY CREDIT OCT 2026'), 'income');
eq('SWIGGY', guessSectorFromKeywords('SWIGGY ORDER 12345'), 'food_out');
eq('MYNTRA', guessSectorFromKeywords('MYNTRA DESIGNS'), 'shopping');
eq('CESC electricity', guessSectorFromKeywords('CESC LTD KOLKATA'), 'utilities');
eq('unknown merchant', guessSectorFromKeywords('SOME RANDOM SHOP'), null);

// ---------------------------------------------------------------------------
console.log('resolveDeterministic');
const sectors = [
  { id: 's1', slug: 'food_out', name: 'Eating Out', icon: null },
  { id: 's2', slug: 'groceries', name: 'Groceries', icon: null },
  { id: 's3', slug: 'transport', name: 'Transport', icon: null },
  { id: 's4', slug: 'uncategorized', name: 'Uncategorized', icon: null },
];
const products = [
  { id: 'p1', sectorId: 's1', name: 'Cha', normalizedName: 'cha', useCount: 785 },
  { id: 'p2', sectorId: 's2', name: 'Grocery', normalizedName: 'grocery', useCount: 305 },
  { id: 'p3', sectorId: 's1', name: 'Coffee', normalizedName: 'coffee', useCount: 16 },
];
const aliases = [
  { id: 'a1', productId: 'p3', pattern: 'cold coffee at keventers', patternType: 'contains', confidence: 0.9 },
  { id: 'a2', productId: 'p1', pattern: '^badsyntax(', patternType: 'regex', confidence: 0.8 },
];
const tax = buildTaxonomy(sectors, products, aliases);

eq('exact match on whole string', resolveDeterministic(tax, 'Cha').product?.name, 'Cha');
eq('exact match on leading segment', resolveDeterministic(tax, 'Cha | Cold tea at stall').product?.name, 'Cha');
eq('exact is free (via=exact)', resolveDeterministic(tax, 'Cha').via, 'exact');
eq('exact confidence', resolveDeterministic(tax, 'Cha').confidence, 0.99);
eq('alias wins for merchant string', resolveDeterministic(tax, 'Cold coffee at keventers').via, 'alias');
eq('alias resolves to product', resolveDeterministic(tax, 'Cold coffee at keventers').product?.name, 'Coffee');
eq('keyword prior gives sector only', resolveDeterministic(tax, 'UBER RIDE').via, 'keyword');
eq('keyword prior sector', resolveDeterministic(tax, 'UBER RIDE').sectorSlug, 'transport');
eq('keyword prior has no product', resolveDeterministic(tax, 'UBER RIDE').product, null);
eq('unknown falls through', resolveDeterministic(tax, 'zzzz merchant').via, 'none');
eq('empty description is safe', resolveDeterministic(tax, '   ').via, 'none');
// A malformed user regex must not abort the whole batch.
eq('invalid regex alias is skipped, not fatal', resolveDeterministic(tax, 'badsyntax(x').via, 'none');

console.log('needsReview (ambiguous products must reach a human)');
const taxWithAmbiguous = buildTaxonomy(sectors, [
  ...products,
  { id: 'p9', sectorId: 's4', name: 'Charges, Fees', normalizedName: 'chargesfees', useCount: 7 },
], []);
const charges = resolveDeterministic(taxWithAmbiguous, 'Charges, Fees');
eq('ambiguous product still matches exactly', charges.via, 'exact');
eq('ambiguous product is flagged for review', charges.needsReview, true);
eq('unambiguous product is NOT flagged', resolveDeterministic(tax, 'Cha').needsReview, false);
eq('keyword-only match is flagged', resolveDeterministic(tax, 'UBER RIDE').needsReview, true);
eq('unresolved row is flagged', resolveDeterministic(tax, 'zzzz merchant').needsReview, true);

console.log('buildTaxonomyBrief');
const brief = buildTaxonomyBrief(tax, ['food_out']);
truthy('lists sectors', brief.includes('SECTORS:'));
truthy('includes hinted product', brief.includes('Cha'));
truthy('excludes uncategorized sector line', !brief.includes('- uncategorized:'));
truthy('excludes unhinted sector products', !brief.includes('Grocery'));
const ordered = buildTaxonomyBrief(tax, ['food_out']);
truthy('most-used product listed first', ordered.indexOf('Cha') < ordered.indexOf('Coffee'));

console.log('findNearDuplicates');
const dups = findNearDuplicates([
  { id: 'x1', sectorId: 's1', name: 'Idli sambar', useCount: 5 },
  { id: 'x2', sectorId: 's1', name: 'Idli-sambar', useCount: 9 },
  { id: 'x3', sectorId: 's1', name: 'Cha', useCount: 785 },
]);
eq('finds the one duplicate pair', dups.length, 1);
eq('keeps the higher-use name', dups[0].keep, 'x2');
eq('drops the lower-use name', dups[0].drop, 'x1');
truthy('explains itself', dups[0].reason.includes('punctuation and case'));

// ---------------------------------------------------------------------------
console.log('seed list sanity');
const all = Object.values(SECTOR_PRODUCTS).flat();
eq('no duplicate seed product names', all.filter((v, i) => all.indexOf(v) !== i), []);
truthy('every seed sector slug is a real sector', Object.keys(SECTOR_PRODUCTS).every((s) =>
  ['groceries','food_out','transport','housing','utilities','telecom','shopping','health',
   'education','entertainment','loans_transfers','gifts_social','income','uncategorized'].includes(s)),
  JSON.stringify(Object.keys(SECTOR_PRODUCTS)));
truthy('seed has a reasonable product count', all.length >= 100, `count=${all.length}`);

// Every seed name must survive its own canonicalization, or the seed would
// insert a name the resolver can never match.
const unstable = all.filter((n) => canonicalProductName(n) !== n);
eq('all seed names are already canonical', unstable, []);

// If the real sample file is available, check the seed actually covers its
// vocabulary. This is the number that decides whether a first import is free.
const sample = process.env.SAVEIT_SAMPLE_CSV;
if (sample && existsSync(sample)) {
  // Parse with the real parser. A naive split('\n') misreads rows whose quoted
  // note contains a newline, and would report timestamps as category names.
  const { detectDelimiter, parseDelimited, detectHeaderRow, mapColumns } =
    await import('../supabase/functions/_shared/parse.ts');
  const text = readFileSync(sample, 'utf8');
  const parsed = parseDelimited(text, detectDelimiter(text));
  const hIdx = detectHeaderRow(parsed);
  const hmap = mapColumns(parsed[hIdx]);
  const cats = new Set(
    parsed.slice(hIdx + 1)
      .map((r) => (hmap.category !== undefined ? r[hmap.category]?.trim() : ''))
      .filter(Boolean),
  );
  const seedNorm = new Set(all.map(normalizeProductName));
  const missing = [...cats].filter((c) => !seedNorm.has(normalizeProductName(c)));
  console.log(`  (sample) ${cats.size} categories, ${missing.length} not in seed: ${missing.join(', ') || 'none'}`);
  truthy('seed covers >=95% of the sample vocabulary',
    (cats.size - missing.length) / cats.size >= 0.95,
    `coverage=${(((cats.size - missing.length) / cats.size) * 100).toFixed(1)}%`);
} else {
  console.log('  (set SAVEIT_SAMPLE_CSV to also check seed coverage against a real file)');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
