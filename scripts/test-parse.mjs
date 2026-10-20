/**
 * Parser unit tests.
 *
 * Covers the deterministic half of ingestion: delimiter detection, the quoted
 * field state machine, header-row discovery, column-role mapping, and the value
 * coercion helpers (amount, direction, date).
 *
 * Run:  node --experimental-strip-types scripts/test-parse.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectDelimiter, parseDelimited, detectHeaderRow, mapColumns,
  isUsableMap, parseAmount, parseDirection, parseDate,
} from '../supabase/functions/_shared/parse.ts';

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

// ---------------------------------------------------------------------------
console.log('detectDelimiter');
// A semicolon file whose VALUES contain commas. Counting commas would win on
// raw frequency; consistency across lines is what picks the right one.
eq('semicolon file with commas inside values', detectDelimiter(readFileSync(FIXTURE, 'utf8')), ';');
eq('plain comma file', detectDelimiter('date,amount,description\n2026-01-01,10.5,Tea\n2026-01-02,11.5,Coffee\n'), ',');
eq('tab file', detectDelimiter('date\tamount\tdescription\n2026-01-01\t10.5\tTea\n2026-01-02\t11.5\tCoffee\n'), '\t');
eq('pipe file', detectDelimiter('date|amount|description\n2026-01-01|10.5|Tea\n2026-01-02|11.5|Coffee\n'), '|');
eq('empty input falls back to comma', detectDelimiter(''), ',');

console.log('parseDelimited');
eq('simple', parseDelimited('a,b\n1,2\n', ','), [['a', 'b'], ['1', '2']]);
eq('quoted value containing the delimiter', parseDelimited('a,b\n"1,x",2\n', ','), [['a', 'b'], ['1,x', '2']]);
eq('escaped quote inside quotes', parseDelimited('a\n"he said ""hi"""\n', ','), [['a'], ['he said "hi"']]);
eq('multi-line quoted field stays one cell', parseDelimited('a,b\n1,"line one\nline two"\n', ','),
   [['a', 'b'], ['1', 'line one\nline two']]);
eq('CRLF line endings', parseDelimited('a,b\r\n1,2\r\n', ','), [['a', 'b'], ['1', '2']]);
eq('no trailing newline', parseDelimited('a,b\n1,2', ','), [['a', 'b'], ['1', '2']]);
eq('BOM is stripped', parseDelimited('\uFEFFa,b\n1,2\n', ','), [['a', 'b'], ['1', '2']]);
eq('blank lines are dropped', parseDelimited('a,b\n\n1,2\n\n', ','), [['a', 'b'], ['1', '2']]);

console.log('detectHeaderRow (bank files often have preamble)');
const preamble = [
  ['HDFC Bank Statement'],
  ['Period: 01/01/2026 to 31/03/2026'],
  [],
  ['Date', 'Narration', 'Chq Type', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
  ['01/01/2026', 'UPI/SWIGGY', 'DR', '250.00', '', '10000.00'],
];
eq('finds the header below the preamble', detectHeaderRow(preamble), 3);
eq('header at row 0 when there is no preamble', detectHeaderRow(parseDelimited(readFileSync(FIXTURE, 'utf8'), ';')), 0);

console.log('mapColumns');
eq('tracker export', (() => {
  const m = mapColumns(['account','category','currency','amount','type','note','date','payee','envelope_id']);
  return [m.account, m.category, m.currency, m.amount, m.direction, m.note, m.date, m.payee];
})(), [0, 1, 2, 3, 4, 5, 6, 7]);

eq('HDFC-style bank header', (() => {
  const m = mapColumns(['Date','Narration','Chq Type','Withdrawal Amt.','Deposit Amt.','Closing Balance']);
  return { date: m.date, description: m.description, direction: m.direction, debit: m.debit, credit: m.credit };
})(), { date: 0, description: 1, direction: 2, debit: 3, credit: 4 });

eq('SBI-style header', (() => {
  const m = mapColumns(['Txn Date','Value Date','Description','Ref No.','Debit','Credit','Balance']);
  return { date: m.date, description: m.description, debit: m.debit };
})(), { date: 0, description: 2, debit: 4 });

eq('date is not stolen by the description role', (() => {
  const m = mapColumns(['Transaction Date','Transaction Details']);
  return { date: m.date, description: m.description };
})(), { date: 0, description: 1 });

truthy('unusable map is detected', !isUsableMap(mapColumns(['foo', 'bar', 'baz'])));
truthy('usable map needs date + amount + some description',
  isUsableMap(mapColumns(['date', 'amount', 'narration'])));
truthy('category alone can stand in for description',
  isUsableMap(mapColumns(['date', 'amount', 'category'])));

console.log('parseAmount');
eq('plain negative', parseAmount('-10.00'), { amount: 10, negative: true });
eq('thousands separator', parseAmount('1,234.56'), { amount: 1234.56, negative: false });
eq('accounting parentheses', parseAmount('(1,234.00)'), { amount: 1234, negative: true });
eq('rupee symbol', parseAmount('₹1,234'), { amount: 1234, negative: false });
eq('european grouping', parseAmount('1.234,56'), { amount: 1234.56, negative: false });
eq('large negative', parseAmount('-2,878.00'), { amount: 2878, negative: true });
eq('currency code', parseAmount('INR 500'), { amount: 500, negative: false });
eq('plus sign', parseAmount('+500.00'), { amount: 500, negative: false });
eq('comma as decimal (2dp)', parseAmount('1234,50'), { amount: 1234.5, negative: false });
eq('comma as thousands (3dp)', parseAmount('1234,500'), { amount: 1234500, negative: false });
eq('integer', parseAmount('50'), { amount: 50, negative: false });
eq('empty', parseAmount(''), null);
eq('whitespace', parseAmount('   '), null);
eq('garbage', parseAmount('N/A'), null);

console.log('parseDirection');
eq('Dr', parseDirection('Dr'), 'debit');
eq('CR', parseDirection('CR'), 'credit');
eq('Expenses', parseDirection('Expenses'), 'debit');
eq('Income', parseDirection('Income'), 'credit');
eq('Withdrawal', parseDirection('Withdrawal'), 'debit');
eq('Deposit', parseDirection('Deposit'), 'credit');
eq('Refund', parseDirection('Refund'), 'credit');
// "CASH" is a payment_type in the sample, NOT a direction. Misreading it would
// invert half the ledger.
eq('CASH is not a direction', parseDirection('CASH'), null);
eq('empty is not a direction', parseDirection(''), null);
eq('undefined is not a direction', parseDirection(undefined), null);

console.log('parseDate');
eq('iso with time', parseDate('2026-09-26 19:12:03').toISOString(), '2026-09-26T19:12:03.000Z');
eq('iso with T', parseDate('2026-09-26T19:12:03').toISOString(), '2026-09-26T19:12:03.000Z');
eq('iso date only', parseDate('2026-09-26').toISOString(), '2026-09-26T00:00:00.000Z');
eq('dd/mm/yyyy day-first', parseDate('26/09/2026', true).toISOString(), '2026-09-26T00:00:00.000Z');
eq('dd-mm-yyyy', parseDate('26-09-2026', true).toISOString(), '2026-09-26T00:00:00.000Z');
eq('ambiguous honours dayFirst=true', parseDate('05/03/2026', true).toISOString(), '2026-03-05T00:00:00.000Z');
eq('ambiguous honours dayFirst=false', parseDate('05/03/2026', false).toISOString(), '2026-05-03T00:00:00.000Z');
eq('unambiguous even with dayFirst=false', parseDate('26/03/2026', false).toISOString(), '2026-03-26T00:00:00.000Z');
eq('two-digit year', parseDate('26/09/26', true).toISOString(), '2026-09-26T00:00:00.000Z');
eq('31 February is rejected, not rolled over', parseDate('31/02/2026', true), null);
// 13 cannot be a month, so the row disambiguates itself: this is Jan 13, not an
// error. Rejecting it would throw away perfectly good data.
eq('impossible month disambiguates to day', parseDate('01/13/2026', true).toISOString(), '2026-01-13T00:00:00.000Z');
eq('impossible day disambiguates to month', parseDate('13/01/2026', false).toISOString(), '2026-01-13T00:00:00.000Z');
eq('both components > 12 is rejected', parseDate('13/13/2026', true), null);
eq('day 32 is rejected', parseDate('32/01/2026', true), null);
eq('month 0 is rejected', parseDate('01/00/2026', true), null);
eq('garbage', parseDate('not a date'), null);
eq('empty', parseDate(''), null);

console.log('fixture parses cleanly end to end');
const text = readFileSync(FIXTURE, 'utf8');
const rows = parseDelimited(text, detectDelimiter(text));
const h = detectHeaderRow(rows);
const m = mapColumns(rows[h]);
truthy('fixture header map is usable', isUsableMap(m));
eq('fixture row count', rows.length - h - 1, 30);
eq('fixture rows all have 19 fields', rows.slice(h + 1).filter((r) => r.length !== 19).length, 0);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
