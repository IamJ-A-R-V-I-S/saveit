/**
 * Account identity, web side.
 *
 * The canonical key itself is computed in the database (`accounts.normalized_name`,
 * migration 0012) and by `_shared/accounts.ts` for the ingest function. This
 * module deliberately does NOT reimplement the rules: a third copy in the web
 * app is a third thing to keep in sync, and the column is already on every row.
 *
 * What lives here is the part the database cannot answer: which active accounts
 * are currently splitting one ledger, and which of them should survive a merge.
 * Pure and dependency-free so `scripts/test-accounts.mjs` can exercise it
 * without a database.
 */

/** The fields grouping needs. `AccountUsage` satisfies this. */
export interface AccountIdentity {
  id: string;
  name: string;
  normalized_name?: string | null;
  is_archived?: boolean;
}

/**
 * Groups of active accounts that normalize to the same key.
 *
 * Archived rows are ignored on purpose: after a merge the loser is archived and
 * its transactions now point at the survivor, so it is not splitting anything.
 * A group is only returned when it has two or more members — one account with
 * its own key is the healthy state.
 */
export function accountDuplicateGroups<T extends AccountIdentity>(accounts: T[]): T[][] {
  const groups = new Map<string, T[]>();

  for (const account of accounts) {
    if (account.is_archived) continue;
    const key = (account.normalized_name ?? "").trim();
    if (!key) continue;

    const group = groups.get(key);
    if (group) group.push(account);
    else groups.set(key, [account]);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => a[0].name.localeCompare(b[0].name));
}

/**
 * The account that should survive a merge: the one with the most transactions.
 *
 * Ties break on name so the suggestion is stable between renders. `txn_count`
 * defaults to 0, which makes an account with no history the one folded away.
 */
export function preferredSurvivor<T extends AccountIdentity & { txn_count?: number }>(
  group: T[],
): T {
  return [...group].sort(
    (a, b) => (b.txn_count ?? 0) - (a.txn_count ?? 0) || a.name.localeCompare(b.name),
  )[0];
}
