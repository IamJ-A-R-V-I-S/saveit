import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Transaction } from "@/lib/types";

/**
 * The review queue.
 *
 * Ingest auto-categorizes what it is sure about and parks the rest here. Two
 * kinds of row land in `categorize_status = 'review'`:
 *
 *   1. the deterministic resolver found nothing (a description the seed taxonomy
 *      has never seen — `Ericsson` in the sample data), and
 *   2. it found an EXACT match on a deliberately ambiguous product.
 *
 * (2) is the interesting one. `Charges, Fees` matches at confidence 0.99 but
 * covers exam fees, brokerage, a maid and a freelancer payment in the real
 * data. Auto-accepting it would produce a ledger that looks confident and is
 * wrong, which is worse than an empty one — so an ambiguous-sector exact match
 * is routed here instead.
 */

const SELECT = `
  *,
  account:accounts!transactions_account_id_fkey ( name, kind ),
  product:products!transactions_product_id_fkey (
    id, name,
    sector:sectors ( slug, name, icon )
  )
`;

export async function getReviewQueue(limit = 200): Promise<Transaction[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("transactions")
    .select(SELECT)
    .eq("categorize_status", "review")
    // Oldest first: the backlog drains in the order it arrived.
    .order("occurred_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("getReviewQueue:", error.message);
    return [];
  }
  return (data as Transaction[]) ?? [];
}

/**
 * Rows still waiting on the LLM.
 *
 * Distinct from the review queue: these are not ambiguous, they are unresolved
 * and queued for `categorize`. Showing them separately keeps "needs your
 * judgement" from being confused with "the model hasn't got to it yet".
 */
export async function getPendingCount(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("categorize_status", "pending");

  if (error) {
    console.error("getPendingCount:", error.message);
    return 0;
  }
  return count ?? 0;
}

/**
 * Descriptions grouped by frequency, for the "these 12 strings are 80% of your
 * queue" view. Fixing one high-frequency description clears many rows at once —
 * `correct` writes an alias, so it also clears every future row like it.
 */
export async function getReviewClusters(limit = 20) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("v_description_frequency")
    .select("*")
    .is("product_id", null)
    .order("occurrences", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getReviewClusters:", error.message);
    return [];
  }
  return (
    (data as {
      description_norm: string;
      product_id: string | null;
      occurrences: number;
      total_spend: string | number;
      first_seen: string;
      last_seen: string;
    }[]) ?? []
  );
}
