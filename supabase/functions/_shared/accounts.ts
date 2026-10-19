/**
 * Account identity.
 *
 * An account is whatever a statement calls it. The sample tracker writes
 * `Slice bank` on 77 rows and `Slice` on 2, but both are one account — and two
 * accounts in the ledger means the filter offers both and every per-account
 * total is wrong. `canonicalAccountName` folds those spellings onto one key,
 * which the database stores as `accounts.normalized_name` (migration 0012) and
 * `ensureAccount` uses to find an existing row.
 *
 * The contract: this function MUST produce the same string as
 * `public.canonical_account_name()` in 0012. It is not a "close enough"
 * normalization. The trigger on `accounts` recomputes the column on every
 * insert, so a rule implemented here but not in SQL is overwritten before the
 * row is read back — `ensureAccount` then misses the row it just created and
 * creates the duplicate this file exists to prevent.
 *
 * Rules, in order:
 *   1. lowercase
 *   2. every run of characters that is not a letter or digit becomes a space
 *   3. trim
 *   4. strip trailing `bank` / `account` / `ac`, repeatedly
 *
 * Step 4 is trailing-only on purpose: "Bank of Baroda" keeps its first word,
 * and a bare "Bank" keeps its only word because there is nothing before it to
 * trim to. `Slice bank account` and `Slice bank` both end up as `slice`.
 *
 * One deliberate omission: the SQL contains `regexp_replace(t, '\ba/c\b', …)`
 * and `'\bacct\b'`, apparently to erase "A/C" and "acct". In Postgres regular
 * expressions `\b` is a BACKSPACE character, not a word boundary (`\y`), so
 * both calls match nothing for ordinary names and "A/C Slice" canonicalizes to
 * `a c slice`. Mirroring the deployed behaviour here is the safe choice; using
 * JS's `\b` (a real word boundary) would make the two sides disagree and split
 * accounts. If that rule is ever wanted, fix the SQL in a new migration and
 * this function in the same commit — `scripts/test-accounts.mjs` pins the
 * current behaviour.
 */

/** Trailing generic words that name the container, not the account. */
const TRAILING_GENERIC = /\s(bank|account|ac)$/;

/**
 * The account's identity key: `Slice`, `SLICE BANK`, `Slice-bank` → `slice`.
 *
 * Pure and dependency-free so the local test suite can import it without Deno,
 * a database, or the Supabase client.
 */
export function canonicalAccountName(raw: string | null | undefined): string {
  let name = (raw ?? "").toLowerCase();

  // Letters and digits survive; punctuation, slashes, brackets, emoji and
  // whitespace all become a single separator. "Saving(mom)" -> "saving mom".
  name = name.replace(/[^a-z0-9]+/g, " ").trim();

  // Loop, because "Slice bank account" has two generic suffixes and SQL uses a
  // while loop too. At least one word always remains: the pattern needs a space
  // before the suffix, so a lone "Bank" is never emptied out.
  while (TRAILING_GENERIC.test(name)) {
    name = name.replace(TRAILING_GENERIC, "");
  }

  return name;
}

/** True when two spellings name the same account. Empty names never match. */
export function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = canonicalAccountName(a);
  return key !== "" && key === canonicalAccountName(b);
}

/**
 * Whether an account is cash.
 *
 * No bank statement will ever contain cash, so a cash account can only be
 * filled by manual entry — `ensureAccount` sets `manual_only` from this. 59% of
 * the sample's transactions are cash, so getting the flag right matters for
 * coverage reporting. "Cashback" is not cash: the word boundary matters.
 */
export function isCashAccount(raw: string | null | undefined): boolean {
  const name = (raw ?? "").trim();
  if (!name) return false;
  return /^cash$/i.test(name) || /\bcash\b/i.test(name);
}
