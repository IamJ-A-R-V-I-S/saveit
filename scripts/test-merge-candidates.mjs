/**
 * Merge-queue rules.
 *
 * The queue's job is to catch spelling variants, not related dishes. This suite
 * pins the cases that made the first version unusable — Ruti vs Ruti-tarka and
 * Kachori paratha vs Kachori paratha egg — alongside the variants it should
 * still find.
 *
 * Run:  node --experimental-strip-types scripts/test-merge-candidates.mjs
 */
import {
  duplicateReason,
  findMergeCandidates,
  levenshtein,
  orderedPair,
  pairKey,
} from '../apps/web/lib/taxonomy-candidates.ts';
import { SECTOR_PRODUCTS } from '../supabase/functions/_shared/taxonomy-seed.ts';

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${name}`);
  else {
    fails++;
    console.log(`  FAIL ${name}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
  }
};
const truthy = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fails++; console.log(`  FAIL ${name} ${detail}`); }
};

let seq = 0;
const p = (name, extra = {}) => ({
  id: extra.id ?? `id-${++seq}`,
  sector_id: extra.sector_id ?? 'food_out',
  name,
  normalized_name: name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
  use_count: extra.use_count ?? 0,
  is_seeded: extra.is_seeded ?? false,
  ...extra,
});

// ---------------------------------------------------------------------------
console.log('different dishes that share a word are NOT duplicates');
// From the live taxonomy: all four are real, distinct, seeded products.
eq('Ruti vs Ruti-tarka', duplicateReason(p('Ruti'), p('Ruti-tarka')), null);
eq('Ruti vs Ruti-curry', duplicateReason(p('Ruti'), p('Ruti-curry')), null);
eq('Kachori paratha vs Kachori paratha egg',
  duplicateReason(p('Kachori paratha'), p('Kachori paratha egg')), null);
eq('Rice-chicken vs Rice-egg',
  duplicateReason(p('Rice-chicken'), p('Rice-egg')), null);
eq('Chicken Biryani vs Biryani',
  duplicateReason(p('Chicken Biryani'), p('Biryani')), null);
eq('Coffee vs Coffee powder',
  duplicateReason(
    p('Coffee', { sector_id: 'food_out' }),
    p('Coffee powder', { sector_id: 'groceries' }),
  ), null);

console.log('seed products are never offered against each other');
// Even a pair the spelling rules would otherwise catch: the seed list is
// curated and its names are distinct by construction.
eq('two seeded products',
  duplicateReason(
    p('Cha', { is_seeded: true }),
    p('Cha (evening)', { is_seeded: true }),
  ), null);

console.log('spelling variance IS still suggested');
eq('Cha vs Cha (evening)',
  duplicateReason(p('Cha'), p('Cha (evening)')), 'same name plus a qualifier');
eq('Cha vs Cha - evening',
  duplicateReason(p('Cha'), p('Cha - evening')), 'same name plus a qualifier');
eq('Coffee vs Coffee (night)',
  duplicateReason(p('Coffee'), p('Coffee (night)')), 'same name plus a qualifier');
eq('Idli sambar vs Idli-sambar',
  duplicateReason(p('Idli sambar'), p('Idli-sambar')), 'same name, different punctuation');
eq('Chanachur0 vs Chanachur',
  duplicateReason(p('Chanachur0'), p('Chanachur')), 'one character apart');
eq('Kachori paratha vs Kachori parata (typo)',
  duplicateReason(p('Kachori paratha'), p('Kachori parata')), 'one character apart');
eq('Ruti vs Roti (spelling of the same dish)',
  duplicateReason(p('Ruti'), p('Roti')), 'one character apart');
eq('qualifier on the shorter side is detected both ways',
  duplicateReason(p('Cha (evening)'), p('Cha')), 'same name plus a qualifier');

console.log('near-miss guards');
eq('"egg" is an ingredient, not a qualifier',
  duplicateReason(p('Kachori paratha'), p('Kachori paratha egg')), null);
eq('three-letter names are left alone',
  duplicateReason(p('Cha'), p('Chai')), null);
eq('a shared prefix that is not a whole word does not count',
  duplicateReason(p('Ruti'), p('Rutika')), null);
eq('name + two qualifiers',
  duplicateReason(p('Cha'), p('Cha evening extra')), 'same name plus a qualifier');
eq('name + qualifier + food word is rejected',
  duplicateReason(p('Cha'), p('Cha evening egg')), null);

console.log('levenshtein');
eq('identical', levenshtein('ruti', 'ruti'), 0);
eq('one substitution', levenshtein('ruti', 'roti'), 1);
eq('one insertion', levenshtein('ruti', 'rutis'), 1);
eq('length gap short-circuits at 2', levenshtein('ruti', 'rutitarka'), 2);

console.log('pair ordering');
eq('pairKey is order independent', pairKey('b', 'a'), pairKey('a', 'b'));
eq('orderedPair sorts', orderedPair('b', 'a'), ['a', 'b']);

// ---------------------------------------------------------------------------
console.log('findMergeCandidates');
const candidates = findMergeCandidates([
  p('Ruti', { use_count: 15, is_seeded: true }),
  p('Ruti-tarka', { use_count: 83, is_seeded: true }),
  p('Kachori paratha', { use_count: 56, is_seeded: true }),
  p('Kachori paratha egg', { use_count: 1, is_seeded: true }),
  p('Cha', { use_count: 785 }),
  p('Cha (evening)', { use_count: 12 }),
  p('Chanachur0', { use_count: 2 }),
  p('Chanachur', { use_count: 40 }),
  p('Thumbs-up', { use_count: 400 }),
]);

eq('only the spelling variants surface', candidates.length, 2);
truthy('Ruti is not paired with Ruti-tarka',
  !candidates.some((c) => [c.keep.name, c.drop.name].sort().join('|') === 'Ruti-tarka|Ruti'));
truthy('Kachori paratha is not paired with its egg variant',
  !candidates.some((c) => [c.keep.name, c.drop.name].sort().join('|') === 'Kachori paratha egg|Kachori paratha'));
eq('more-used product is kept', candidates.find((c) => c.drop.name === 'Cha (evening)')?.keep.name, 'Cha');
eq('highest-impact pair first', candidates[0].keep.name, 'Cha');
eq('candidates are unique pairs',
  new Set(candidates.map((c) => pairKey(c.keep.id, c.drop.id))).size, candidates.length);

console.log('live seed taxonomy produces no self-suggestions');
const seeded = Object.entries(SECTOR_PRODUCTS).flatMap(([sector, names]) =>
  names.map((name) => p(name, { sector_id: sector, is_seeded: true, use_count: 1 })),
);
eq('no pair among the 100+ seeded products', findMergeCandidates(seeded).length, 0);

// ---------------------------------------------------------------------------
console.log(fails === 0 ? '\nAll merge-candidate tests passed.' : `\n${fails} failure(s).`);
process.exit(fails === 0 ? 0 : 1);
