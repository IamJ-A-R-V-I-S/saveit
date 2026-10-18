"use server";

import { revalidatePath } from "next/cache";
import { callFunction, describeEdgeError } from "@/lib/edge";
import { createClient, currentUser } from "@/lib/supabase/server";
import type { CorrectResult, Direction } from "@/lib/types";

/**
 * Ledger mutations.
 *
 * Manual entry exists alongside statement parsing because statements miss
 * things — cash handed to someone, a split bill, a subscription paid from an
 * account you never export. Both feed the same table, so the coach sees one
 * ledger rather than two half-truths.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

/** The account manual entries land in when none is chosen. */
async function ensureManualAccount(): Promise<string | null> {
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("accounts")
    .select("id")
    .eq("manual_only", true)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id;

  const { data, error } = await supabase
    .from("accounts")
    .insert({ name: "Manual entry", kind: "other", manual_only: true })
    .select("id")
    .single();

  if (error) {
    console.error("ensureManualAccount:", error.message);
    return null;
  }
  return data?.id ?? null;
}

export async function addTransaction(formData: FormData): Promise<ActionResult> {
  const description = String(formData.get("description") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const occurredAt = String(formData.get("occurredAt") ?? "").trim();
  const direction = (String(formData.get("direction") ?? "debit") || "debit") as Direction;
  const productId = String(formData.get("productId") ?? "") || null;
  const accountId = String(formData.get("accountId") ?? "") || null;
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!description) return { ok: false, error: "A description is required." };

  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." };
  }

  const when = occurredAt ? new Date(occurredAt) : new Date();
  if (Number.isNaN(when.getTime())) {
    return { ok: false, error: "That date isn't valid." };
  }
  // A future expense is almost always a typo, and it would silently distort the
  // current month's totals and the coach's window.
  if (when.getTime() > Date.now() + 86_400_000) {
    return { ok: false, error: "That date is in the future." };
  }

  const supabase = await createClient();
  const account = accountId ?? (await ensureManualAccount());
  if (!account) return { ok: false, error: "Could not find or create an account for this entry." };

  /*
   * The dedup key is computed in the database rather than here.
   *
   * It must be byte-identical to the one the ingest pipeline produces or the
   * same expense imported from a statement AND typed by hand would appear
   * twice. `make_dedup_key` (migration 0004) mirrors
   * `_shared/normalize.ts` exactly, and `scripts/test-dedup-parity.mjs` pins
   * that the two agree. Reimplementing the hash in the browser would break
   * that guarantee in the one place it matters most.
   */
  const user = await currentUser();
  if (!user) return { ok: false, error: "You are signed out." };

  const { data: keyed, error: keyErr } = await supabase.rpc("make_dedup_key", {
    p_user_id: user.id,
    p_account_id: account,
    p_occurred_at: when.toISOString(),
    p_amount: amount,
    p_description: description,
    p_occurrence: 0,
  });

  if (keyErr) {
    console.error("make_dedup_key:", keyErr.message);
    return { ok: false, error: `Could not compute a dedup key: ${keyErr.message}` };
  }

  const { error } = await supabase.from("transactions").insert({
    account_id: account,
    product_id: productId,
    amount,
    direction,
    occurred_at: when.toISOString(),
    raw_description: description,
    note,
    dedup_key: String(keyed ?? ""),
    // `corrected` when the user picked a product, otherwise it waits for the
    // categorizer. Never `auto` — nothing inferred this.
    categorize_status: productId ? "corrected" : "pending",
    confidence: productId ? 1 : null,
    categorize_reason: productId ? "manual entry" : null,
  });

  if (error) {
    if (/duplicate/i.test(error.message) || error.code === "23505") {
      return { ok: false, error: "That exact transaction is already in your ledger." };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteTransaction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("transactions").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/transactions");
  revalidatePath("/review");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Correct a categorization.
 *
 * This goes through the `correct` edge function rather than a plain UPDATE
 * because the valuable part is the side effect: it records a `corrections` row
 * and writes an alias, so the same description is resolved deterministically
 * from then on and never spends another model call. With `applyToSimilar` it
 * also fixes every other row sharing that description — the sample data has
 * `Cha` 785 times, so one correction can clean up 785 rows.
 */
export async function correctTransaction(input: {
  transactionIds: string[];
  productId?: string | null;
  productName?: string;
  sectorSlug?: string;
  applyToSimilar?: boolean;
}): Promise<{ ok: true; result: CorrectResult } | { ok: false; error: string }> {
  if (input.transactionIds.length === 0) {
    return { ok: false, error: "Select at least one transaction." };
  }

  try {
    const result = await callFunction<CorrectResult>("correct", { body: input });
    revalidatePath("/transactions");
    revalidatePath("/review");
    revalidatePath("/dashboard");
    revalidatePath("/taxonomy");
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: describeEdgeError(err) };
  }
}

/**
 * Direct product reassignment, with no edge function.
 *
 * The fallback when `correct` isn't deployed: the row is fixed but no alias is
 * learned, so the next identical description will need fixing again. Better than
 * a dead button, and the UI says which of the two happened.
 */
export async function assignProduct(
  transactionIds: string[],
  productId: string,
): Promise<ActionResult> {
  if (transactionIds.length === 0) return { ok: false, error: "Select at least one transaction." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("transactions")
    .update({
      product_id: productId,
      categorize_status: "corrected",
      confidence: 1,
      categorize_reason: "manually assigned",
    })
    .in("id", transactionIds);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/transactions");
  revalidatePath("/review");
  revalidatePath("/dashboard");
  return { ok: true };
}
