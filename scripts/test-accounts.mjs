/**
 * Account identity.
 *
 * `canonicalAccountName()` and `public.canonical_account_name()` (migration
 * 0012) must agree. The database trigger stamps `accounts.normalized_name` from
 * the SQL side, so a rule the TypeScript does not share makes `ensureAccount`
 * miss the row it just inserted and split the account again — the exact bug the
 * migration exists to fix. The expectations below were read off the live
 * function, including the surprising `A/C Slice` row (Postgres `\b` is a
 * backspace, not a word boundary).
 *
 * Run:  node --experimental-strip-types scripts/test-accounts.mjs
 */
import { canonicalAccountName, isCashAccount, sameAccount } from '../supabase/functions/_shared/accounts.ts';
import {
  accountDuplicateGroups,
  preferredSurvivor,
} from '../apps/web/lib/account-groups.ts';

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

// ---------------------------------------------------------------------------
console.log('the reported bug: Slice and Slice bank are one account');
// From the live data: 77 rows say "Slice bank", 2 say "Slice".
eq('Slice', canonicalAccountName('Slice'), 'slice');
eq('Slice bank', canonicalAccountName('Slice bank'), 'slice');
eq('SLICE BANK', canonicalAccountName('SLICE BANK'), 'slice');
eq('same account', sameAccount('Slice', 'Slice bank'), true);
eq('same account with punctuation', sameAccount('Slice-bank', 'Slice'), true);
eq('same account with a double suffix', sameAccount('Slice bank account', 'Slice'), true);
eq('different accounts stay different', sameAccount('Slice', 'SBI'), false);

// ---------------------------------------------------------------------------
console.log('canonicalisation, pinned against public.canonical_account_name()');
const CASES = [
  ['Slice', 'slice'],
  ['Slice bank', 'slice'],
  ['SLICE BANK', 'slice'],
  ['Slice-bank', 'slice'],
  ['Slice Bank!', 'slice'],
  ['  Slice   Bank  ', 'slice'],
  ['Slice bank account', 'slice'],
  ['Slice bank bank', 'slice'],
  ['Slice ac', 'slice'],
  ['Slice cuenta', 'slice cuenta'],
  ['Saving(mom)', 'saving mom'],
  ['HDFC Bank Account', 'hdfc'],
  ['Bank of Baroda', 'bank of baroda'],
  ['Kotak bank', 'kotak'],
  // A lone generic word is never emptied out.
  ['Bank', 'bank'],
  ['Bank bank', 'bank'],
  ['Ac', 'ac'],
  ['', ''],
  ['   ', ''],
  ['A/C Slice', 'a c slice'],
  ['Slice Acct', 'slice acct'],
  ['a/c', 'a c'],
  ['slice/account', 'slice'],
  ['Slice A/C Bank', 'slice a c'],
];
for (const [raw, want] of CASES) eq(`"${raw}"`, canonicalAccountName(raw), want);

eq('null is empty', canonicalAccountName(null), '');
eq('undefined is empty', canonicalAccountName(undefined), '');
eq('empty names never match each other', sameAccount('', ''), false);

// The live SQL keeps `\b` (backspace) around a/c and acct, so these two are
// no-ops. If this suite ever fails here, the SQL was changed: change both
// sides together, never just one.
truthy('A/C is NOT stripped (deployed SQL behaviour)', !sameAccount('A/C Slice', 'Slice'));
truthy('Acct is NOT stripped (deployed SQL behaviour)', !sameAccount('Slice Acct', 'Slice'));

// ---------------------------------------------------------------------------
console.log('cash accounts');
eq('Cash', isCashAccount('Cash'), true);
eq('CASH', isCashAccount('CASH'), true);
eq('Petty cash', isCashAccount('Petty cash'), true);
eq('Cashback is not cash', isCashAccount('Cashback'), false);
eq('MyCash is not cash', isCashAccount('MyCash'), false);
eq('empty', isCashAccount(''), false);

// ---------------------------------------------------------------------------
console.log('duplicate groups');
const account = (id, name, extra = {}) => ({
  id,
  name,
  normalized_name: canonicalAccountName(name),
  is_archived: false,
  txn_count: 0,
  ...extra,
});

const slice = account('a', 'Slice', { txn_count: 2 });
const sliceBank = account('b', 'Slice bank', { txn_count: 77 });
const sbi = account('c', 'SBI', { txn_count: 210 });
const mergedAway = account('d', 'Slice (old)', { is_archived: true, txn_count: 1 });

const groups = accountDuplicateGroups([slice, sliceBank, sbi, mergedAway]);
eq('one group for the two active Slice rows', groups.length, 1);
eq('group members', groups[0].map((a) => a.name), ['Slice', 'Slice bank']);
truthy('the archived row is not part of a group',
  !groups.flat().some((a) => a.id === 'd'));
eq('distinct names produce no groups', accountDuplicateGroups([sbi, slice]).length, 0);
eq('one account produces no groups', accountDuplicateGroups([slice]).length, 0);
eq('blank keys are ignored',
  accountDuplicateGroups([
    { id: 'x', name: '???', normalized_name: '', is_archived: false },
    { id: 'y', name: '!!!', normalized_name: '', is_archived: false },
  ]).length, 0);
eq('missing keys are ignored',
  accountDuplicateGroups([
    { id: 'x', name: '???', is_archived: false },
    { id: 'y', name: '!!!', is_archived: false },
  ]).length, 0);

console.log('survivor choice');
eq('most-used account survives', preferredSurvivor([slice, sliceBank]).name, 'Slice bank');
eq('order does not matter', preferredSurvivor([sliceBank, slice]).name, 'Slice bank');
eq('ties break on name', preferredSurvivor([
  account('p', 'Beta'),
  account('q', 'Alpha'),
]).name, 'Alpha');

// ---------------------------------------------------------------------------
console.log('the sample tracker collapses to two accounts');
// scripts/fixtures/sample-tracker.csv says "SBI" on 21 rows and "Cash" on 9.
// A real export also contains "Slice bank" (77) and "Slice" (2); they must end
// up as ONE key, leaving Cash, SBI and Slice.
const fixtureKeys = [...new Set(['SBI', 'Cash', 'Slice', 'Slice bank'].map(canonicalAccountName))];
eq('canonical keys', fixtureKeys, ['sbi', 'cash', 'slice']);
eq('groups in the fixture', accountDuplicateGroups([
  account('sbi', 'SBI'),
  account('cash', 'Cash'),
  account('slice', 'Slice'),
  account('slice-bank', 'Slice bank'),
]).map((group) => group.map((a) => a.name)), [['Slice', 'Slice bank']]);

// ---------------------------------------------------------------------------
console.log(fails === 0 ? '\nAll account tests passed.' : `\n${fails} failure(s).`);
process.exit(fails === 0 ? 0 : 1);
