"use server";

import { revalidatePath } from "next/cache";
import { createClient, currentUser } from "@/lib/supabase/server";

/**
 * Account mutations.
 *
 * There is exactly one: merging. Accounts are otherwise created by ingest
 * (`ensureAccount`), and `normalized_name` already makes two spellings resolve
 * to one row on new imports — merging is for the duplicates a tenant acquired
 * before migration 0012, or for genuinely different names that are one account
 * ("SBI" and "SBI-Reja").
 */

export type MergeAccountsResult =
  | { ok: true; moved: number }
  | { ok: false; error: string };

/**
 * Collapse one account into another.
 *
 * Goes through the `merge_accounts` RPC rather than a sequence of updates for
 * two reasons that are both data-loss bugs if ignored:
 *
 *   1. `transactions.dedup_key` embeds `account_id` (0004). Moving rows without
 *      recomputing it means the next upload of the same statement computes a
 *      different key and inserts duplicates of rows that are already there.
 *   2. The losing account is ARCHIVED, not deleted. `transactions.account_id`
 *      is ON DELETE CASCADE, so deleting it would take any row the move missed.
 *
 * The RPC also refuses archived accounts and accounts owned by another tenant.
 */
export async function mergeAccounts(keepId: string, dropId: string): Promise<MergeAccountsResult> {
  if (!isUuid(keepId) || !isUuid(dropId)) return { ok: false, error: "Unknown account." };
  if (keepId === dropId) return { ok: false, error: "Pick two different accounts." };

  const supabase = await createClient();
  const user = await currentUser();
  if (!user) return { ok: false, error: "You are signed out." };

  // Read both through the caller's RLS-scoped client first. Another tenant's id
  // simply does not exist here, so the message is the same as a deleted row and
  // the RPC is never asked to arbitrate ownership.
  const { data: owned, error: readError } = await supabase
    .from("accounts")
    .select("id")
    .in("id", [keepId, dropId])
    .eq("is_archived", false);

  if (readError) return { ok: false, error: readError.message };
  if ((owned ?? []).length !== 2) {
    return { ok: false, error: "One of those accounts no longer exists." };
  }

  const { data, error } = await supabase.rpc("merge_accounts", {
    p_keep_id: keepId,
    p_drop_id: dropId,
  });

  if (error) {
    // 42883 = undefined_function. The UI is shipped with the app, the function
    // with the migration, and those deploy separately.
    if (error.code === "42883") {
      return {
        ok: false,
        error: "Merging accounts needs migration 0012 — run `supabase db push` and try again.",
      };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/settings");
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  revalidatePath("/documents");
  return { ok: true, moved: Number(data ?? 0) };
}

/** A UUID, as Postgres would accept it. Guards the uuid casts above. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
