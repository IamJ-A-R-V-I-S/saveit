import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Insight, InsightStatus } from "@/lib/types";

/**
 * Coach output.
 *
 * Insights are ranked savings opportunities with a rupee estimate and the
 * transactions behind them. They are written by the `coach` function (on demand
 * or on the pg_cron schedule) and read here.
 */

const SELECT = `
  *,
  sector:sectors ( slug, name, icon ),
  product:products ( name )
`;

/**
 * Live insights, best first.
 *
 * `dismissed` is excluded by default: a dismissed opportunity is a decision the
 * user already made, and re-surfacing it every visit trains them to ignore the
 * whole panel.
 */
export async function getInsights(options: {
  includeDismissed?: boolean;
  limit?: number;
  kind?: string;
} = {}): Promise<Insight[]> {
  const { includeDismissed = false, limit = 30, kind } = options;
  const supabase = await createClient();

  let query = supabase.from("insights").select(SELECT);
  if (!includeDismissed) query = query.neq("status", "dismissed");
  if (kind) query = query.eq("kind", kind);

  const { data, error } = await query
    .order("rank", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getInsights:", error.message);
    return [];
  }
  return (data as Insight[]) ?? [];
}

/** The most recent coach run's window, for "covering Jun–Aug". */
export async function getLatestInsightWindow(): Promise<{
  start: string | null;
  end: string | null;
  generatedAt: string | null;
  count: number;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("insights")
    .select("period_start, period_end, created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) {
    return { start: null, end: null, generatedAt: null, count: 0 };
  }
  const latest = data[0];

  const { count } = await supabase
    .from("insights")
    .select("id", { count: "exact", head: true })
    .eq("created_at", latest.created_at);

  return {
    start: latest.period_start,
    end: latest.period_end,
    generatedAt: latest.created_at,
    count: count ?? 0,
  };
}

/** How many insights the user has not looked at yet. Drives the nav badge. */
export async function getUnseenInsightCount(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("insights")
    .select("id", { count: "exact", head: true })
    .eq("status", "new")
    .neq("kind", "summary");

  if (error) return 0;
  return count ?? 0;
}

export async function setInsightStatus(id: string, status: InsightStatus) {
  const supabase = await createClient();
  const { error } = await supabase.from("insights").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Total rupees the coach says are recoverable per month, across live insights. */
export function totalMonthlyOpportunity(insights: Insight[]): number {
  return insights
    .filter((i) => i.status !== "dismissed" && i.kind === "opportunity")
    .reduce((sum, i) => sum + (Number(i.monthly_saving_estimate) || 0), 0);
}
