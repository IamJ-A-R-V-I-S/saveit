import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { AccountKind, AccountUsage } from "@/lib/types";

/**
 * The user's accounts, with usage.
 *
 * `v_account_usage` (migration 0012) aggregates transactions per account.
 * `security_invoker` means the caller's RLS applies to both sides of the join,
 * so there is no user filter here — see the note in lib/data/profile.ts.
 *
 * Archived accounts are returned, not filtered out. A merge archives the loser
 * and moves its rows to the survivor; the row still exists, and the Settings
 * card needs to know about it to explain where the history went.
 */
export async function getAccountsWithUsage(): Promise<AccountUsage[]> {
  const supabase = await createClient();

  const [{ data: accountRows, error }, usageResult] = await Promise.all([
    supabase
      .from("accounts")
      .select("id, name, normalized_name, kind, manual_only, is_archived")
      .order("name"),
    supabase
      .from("v_account_usage")
      .select("account_id, txn_count, spend, income, first_seen, last_seen"),
  ]);

  if (error) {
    console.error("getAccountsWithUsage:", error.message);
    return [];
  }

  // 42P01 = undefined_table: the view arrives with 0012, and a project that has
  // not run it yet should still list accounts. Missing usage becomes zeroes
  // rather than a broken Settings page.
  const usage = new Map<
    string,
    {
      txn_count: number;
      spend: string | number | null;
      income: string | number | null;
      first_seen: string | null;
      last_seen: string | null;
    }
  >();
  if (usageResult.error) {
    if (usageResult.error.code !== "42P01") {
      console.error("getAccountsWithUsage:", usageResult.error.message);
    }
  } else {
    for (const row of (usageResult.data ?? []) as {
      account_id: string;
      txn_count: number;
      spend: string | number | null;
      income: string | number | null;
      first_seen: string | null;
      last_seen: string | null;
    }[]) {
      usage.set(row.account_id, row);
    }
  }

  const accounts = (accountRows ?? []) as {
    id: string;
    name: string;
    normalized_name: string | null;
    kind: AccountKind;
    manual_only: boolean;
    is_archived: boolean;
  }[];

  return accounts
    .map((account) => {
      const stats = usage.get(account.id);
      return {
        id: account.id,
        name: account.name,
        normalized_name: account.normalized_name ?? "",
        kind: account.kind,
        manual_only: account.manual_only,
        is_archived: account.is_archived,
        txn_count: stats?.txn_count ?? 0,
        spend: stats?.spend ?? 0,
        income: stats?.income ?? 0,
        first_seen: stats?.first_seen ?? null,
        last_seen: stats?.last_seen ?? null,
      };
    })
    .sort(
      (a, b) => Number(a.is_archived) - Number(b.is_archived) || a.name.localeCompare(b.name),
    );
}
