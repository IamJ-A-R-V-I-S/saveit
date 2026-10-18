"use server";

import { revalidatePath } from "next/cache";
import { callFunction, describeEdgeError, EdgeFunctionError } from "@/lib/edge";
import { createClient } from "@/lib/supabase/server";
import type { CoachResult, InsightStatus } from "@/lib/types";

/**
 * Coach actions.
 *
 * The coach runs on a pg_cron schedule, but "run it now" is a button because
 * the scheduled job is deliberately inert until the cron GUCs are set (migration
 * 0007) — a fresh install would otherwise show an empty insights page forever
 * with no way to find out why.
 */

export type CoachActionResult =
  | { ok: true; result: CoachResult }
  | { ok: false; error: string; notDeployed: boolean };

/**
 * Generate insights for the last `months` months.
 *
 * Bounded to 12 to match the function: a longer window makes every month look
 * anomalous and the estimates meaningless.
 */
export async function runCoach(options: {
  months?: number;
  push?: boolean;
} = {}): Promise<CoachActionResult> {
  const months = Math.max(1, Math.min(12, options.months ?? 3));

  try {
    const result = await callFunction<CoachResult>("coach", {
      body: { months, push: options.push ?? false },
      // The coach reads months of aggregates and calls the model for narrative.
      timeoutMs: 300_000,
    });

    revalidatePath("/insights");
    revalidatePath("/dashboard");
    return { ok: true, result };
  } catch (err) {
    const notDeployed = err instanceof EdgeFunctionError && err.notDeployed;
    return { ok: false, error: describeEdgeError(err), notDeployed };
  }
}

export async function updateInsightStatus(
  id: string,
  status: InsightStatus,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { error } = await supabase.from("insights").update({ status }).eq("id", id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/insights");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Mark everything currently shown as seen.
 *
 * One update instead of N so opening the insights page does not fire a request
 * per card.
 */
export async function markAllInsightsSeen(ids: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: true };

  const supabase = await createClient();
  const { error } = await supabase
    .from("insights")
    .update({ status: "seen" })
    .in("id", ids)
    .eq("status", "new");

  if (error) return { ok: false, error: error.message };

  revalidatePath("/insights");
  return { ok: true };
}
