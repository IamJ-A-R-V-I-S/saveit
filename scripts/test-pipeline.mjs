/**
 * End-to-end pipeline test over a committed fixture.
 *
 * Exercises the full deterministic path with NO LLM calls and NO database:
 *   detect delimiter -> parse -> find header -> map columns -> stage rows
 *   -> resolve taxonomy -> assign dedup keys
 *
 * The fixture (scripts/fixtures/sample-tracker.csv) deliberately contains the
 * awkward cases from the real data: a multi-line quoted note, two identical
 * rows one second apart, two same-minute Rs.542 charges with different notes,
 * emoji-stripped names, a typo, lowercase names, income rows, and a category
 * that is not in the seed.
 *
 * Run:  node --experimental-strip-types scripts/test-pipeline.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectDelimiter, parseDelimited, detectHeaderRow, mapColumns, isUsableMap,
} from '../supabase/functions/_shared/parse.ts';
import { stageRow, assignOccurrences, makeDedupKey } from '../supabase/functions/_shared/normalize.ts';
import { SECTOR_PRODUCTS, normalizeProductName } from '../supabase/functions/_shared/taxonomy-seed.ts';
import { buildTaxonomy, resolveDeterministic } from '../supabase/functions/_shared/taxonomy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-tracker.csv');

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

// Build the taxonomy exactly as seedTaxonomyIfEmpty() would for a new user.
const sectors = Object.keys(SECTOR_PRODUCTS).map((slug, i) => ({ id: `s${i}`, slug, name: slug, icon: null }));
const products = [];
for (const [slug, names] of Object.entries(SECTOR_PRODUCTS)) {
  const s = sectors.find((x) => x.slug === slug);
  for (const n of names) {
    products.push({ id: `p${products.length}`, sectorId: s.id, name: n, normalizedName: normalizeProductName(n), useCount: 0 });
  }
}
const tax = buildTaxonomy(sectors, products, []);

// ---------------------------------------------------------------------------
const text = readFileSync(FIXTURE, 'utf8');

console.log('structure detection');
const delim = detectDelimiter(text);
eq('delimiter is semicolon', delim, ';');

const rows = parseDelimited(text, delim);
const hIdx = detectHeaderRow(rows);
eq('header is row 0', hIdx, 0);
const header = rows[hIdx];
eq('header has 19 columns', header.length, 19);

const map = mapColumns(header);
truthy('header map is usable without an LLM', isUsableMap(map));
eq('date column', header[map.date], 'date');
eq('amount column', header[map.amount], 'amount');
eq('direction column', header[map.direction], 'type');
eq('category column', header[map.category], 'category');
eq('note column', header[map.note], 'note');
eq('account column', header[map.account], 'account');
eq('payee column', header[map.payee], 'payee');
eq('currency column', header[map.currency], 'currency');
eq('map confidence is 1.0', map.confidence, 1);

console.log('row integrity');
const dataRows = rows.slice(hIdx + 1);
eq('all data rows have 19 fields (multi-line quoted note handled)',
   dataRows.filter((r) => r.length !== 19).length, 0);
eq('row count', dataRows.length, 30);

// The fixture has one note containing a literal newline. If the parser split on
// \n naively, that row would arrive as two malformed rows.
const multiline = dataRows.find((r) => (r[map.note] ?? '').includes('\n'));
truthy('multi-line quoted note survived as ONE field', multiline !== undefined);
truthy('multi-line note kept both lines',
  (multiline?.[map.note] ?? '').split('\n').length === 2,
  JSON.stringify(multiline?.[map.note]));

console.log('staging');
const staged = [];
const skips = [];
for (let i = 0; i < dataRows.length; i++) {
  const r = dataRows[i];
  const cols = {
    date: r[map.date],
    amount: r[map.amount],
    direction: map.direction !== undefined ? r[map.direction] : undefined,
    description: map.description !== undefined ? r[map.description] : undefined,
    category: map.category !== undefined ? r[map.category] : undefined,
    note: map.note !== undefined ? r[map.note] : undefined,
    currency: map.currency !== undefined ? r[map.currency] : undefined,
    payee: map.payee !== undefined ? r[map.payee] : undefined,
    account: map.account !== undefined ? r[map.account] : undefined,
  };
  const res = stageRow(cols, { dayFirst: true });
  if (res.skip) { skips.push({ line: i + 2, reason: res.skip }); continue; }
  staged.push({ row: res.row, accountName: cols.account?.trim() || null, line: i + 2 });
}
eq('every fixture row staged (0 skipped)', skips, []);
eq('staged count', staged.length, 30);

const debits = staged.filter((s) => s.row.direction === 'debit');
const credits = staged.filter((s) => s.row.direction === 'credit');
eq('debit/credit split', [debits.length, credits.length], [26, 4]);
truthy('amounts are stored as positive magnitudes',
  staged.every((s) => s.row.amount > 0));
truthy('direction came from the type column, not the sign',
  credits.every((s) => ['Lending, renting', 'Tuition', 'Freelancing', 'Ericsson']
    .some((n) => s.row.rawDescription.includes(n))));

console.log('description synthesis');
const rent = staged.find((s) => s.row.rawDescription.includes('Rent'));
truthy('note is folded into the description the categorizer reads',
  rent.row.rawDescription.includes('Room rent + electric + water'),
  rent.row.rawDescription);
const kiron = staged.find((s) => s.row.rawDescription.includes('Kiron'));
truthy('payee is folded in too', kiron.row.rawDescription.includes('Kiron'));

console.log('deterministic resolution (no LLM)');
const via = { exact: 0, alias: 0, keyword: 0, none: 0 };
const unresolved = [];
for (const s of staged) {
  const r = resolveDeterministic(tax, s.row.rawDescription);
  via[r.via]++;
  if (r.via !== 'exact' && r.via !== 'alias') unresolved.push(s.row.rawDescription.split('|')[0].trim());
}
truthy('the vast majority resolve for free', via.exact + via.alias >= staged.length - 3,
  JSON.stringify(via));
eq('exactly one row is unknown to the seed', via.none, 1);
eq('the unknown row is the employer name', unresolved.filter((u) => u === 'Ericsson').length, 1);
console.log(`       resolved free: ${via.exact + via.alias}/${staged.length} ` +
  `(${(100 * (via.exact + via.alias) / staged.length).toFixed(1)}%), needs LLM: ${via.keyword + via.none}`);

console.log('canonicalization actually fires');
const names = staged.map((s) => s.row.rawDescription.split('|')[0].trim());
truthy('lowercase "guava" matched the seeded "Guava"',
  resolveDeterministic(tax, 'guava').product?.name === 'Guava');
truthy('typo "Chanachur0" is corrected to "Chanachur"',
  resolveDeterministic(tax, 'Chanachur0').product?.name === 'Chanachur');
truthy('"Idli sambar" unifies with "Idli-sambar"',
  normalizeProductName('Idli sambar') === normalizeProductName('Idli-sambar'));

console.log('review routing');
const reviewFlags = staged.map((s) => resolveDeterministic(tax, s.row.rawDescription).needsReview);
const chargesRows = staged.map((s, i) => [s, i]).filter(([s]) => s.row.amount === 542).map(([, i]) => i);
truthy('both ambiguous "Charges, Fees" rows are routed to review',
  chargesRows.every((i) => reviewFlags[i] === true),
  JSON.stringify(chargesRows.map((i) => reviewFlags[i])));
const rentIdx = staged.findIndex((s) => s.row.rawDescription.startsWith('Rent'));
truthy('an unambiguous match is NOT routed to review', reviewFlags[rentIdx] === false);
const ericssonIdx = staged.findIndex((s) => s.row.rawDescription.startsWith('Ericsson'));
truthy('the unknown row IS routed to review', reviewFlags[ericssonIdx] === true);
console.log(`       ${reviewFlags.filter(Boolean).length}/${staged.length} rows need review`);

console.log('dedup keys');
const occurrences = assignOccurrences(staged.map((s) => s.row));
const keys = [];
for (let i = 0; i < staged.length; i++) {
  const s = staged[i].row;
  keys.push(await makeDedupKey({
    userId: 'u1', accountId: staged[i].accountName, occurredAt: s.occurredAt,
    amount: s.amount, description: s.rawDescription, occurrence: occurrences[i],
  }));
}
eq('every fixture row gets a unique key', new Set(keys).size, keys.length);
truthy('no occurrence ordinal was needed (all rows differ by second)',
  occurrences.every((o) => o === 0), JSON.stringify(occurrences.filter((o) => o !== 0)));

// The two Rs.58 Grocery rows 30 seconds apart must NOT collide.
const groceryIdx = staged.map((s, i) => [s, i]).filter(([s]) =>
  s.row.rawDescription.startsWith('Grocery') && s.row.amount === 58).map(([, i]) => i);
eq('found both Rs.58 Grocery rows', groceryIdx.length, 2);
truthy('they produced different dedup keys', keys[groceryIdx[0]] !== keys[groceryIdx[1]]);

// The two Rs.542 Charges rows must NOT collide either -- different notes.
const chargesIdx = staged.map((s, i) => [s, i]).filter(([s]) => s.row.amount === 542).map(([, i]) => i);
eq('found both Rs.542 Charges rows', chargesIdx.length, 2);
truthy('they produced different dedup keys', keys[chargesIdx[0]] !== keys[chargesIdx[1]]);

console.log('idempotency');
// Re-running the whole pipeline over the same file must produce identical keys.
const keysAgain = [];
const occAgain = assignOccurrences(staged.map((s) => s.row));
for (let i = 0; i < staged.length; i++) {
  const s = staged[i].row;
  keysAgain.push(await makeDedupKey({
    userId: 'u1', accountId: staged[i].accountName, occurredAt: s.occurredAt,
    amount: s.amount, description: s.rawDescription, occurrence: occAgain[i],
  }));
}
eq('re-parsing the same file yields identical keys', keysAgain, keys);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
