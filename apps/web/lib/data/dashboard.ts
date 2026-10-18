import "server-only";
import { createClient } from "@/lib/supabase/server";
import type {
  DashboardSummary,
  MonthlyCoverage,
  MonthlyProductSpend,
  MonthlySectorSpend,
} from "@/lib/types";

/**
 * Dashboard reads.
 *
 * All four come from views rather than being aggregated in TypeScript. The
 * views are `security_invoker`, so they aggregate only the caller's rows; doing
 * this in the database also avoids shipping thousands of transactions to the
 * server just to sum them.
 */

/** The single summary row: totals, date range, review backlog. */
export async function getDashboardSummary(): Promise<DashboardSummary | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("v_dashboard_summary").select("*").maybeSingle();
  if (error) {
    console.error("getDashboardSummary:", error.message);
    return null;
  }
  return (data as DashboardSummary | null) ?? null;
}

/**
 * Per-month coverage: how much of each month is categorized, and how thin the
 * data is.
 *
 * This drives an honesty rule in the UI. Statements arrive partial — the sample
 * data has months with 14 transactions and months with 267 — so a month with
 * almost no rows must be marked sparse rather than shown as "you spent less
 * this month". `months` bounds the range to keep the chart readable.
 */
export async function getMonthlyCoverage(months = 12): Promise<MonthlyCoverage[]> {
  const supabase = await createClient();
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  since.setDate(1);

  const { data, error } = await supabase
    .from("v_monthly_coverage")
    .select("*")
    .gte("month", since.toISOString().slice(0, 10))
    .order("month");

  if (error) {
    console.error("getMonthlyCoverage:", error.message);
    return [];
  }
  return (data as MonthlyCoverage[]) ?? [];
}

export async function getMonthlySectorSpend(months = 12): Promise<MonthlySectorSpend[]> {
  const supabase = await createClient();
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  since.setDate(1);

  const { data, error } = await supabase
    .from("v_monthly_sector_spend")
    .select("*")
    .gte("month", since.toISOString().slice(0, 10))
    .order("month");

  if (error) {
    console.error("getMonthlySectorSpend:", error.message);
    return [];
  }
  return (data as MonthlySectorSpend[]) ?? [];
}

/**
 * Top products in a month — the actionable level.
 *
 * "Eating Out: ₹4,100" is a description; "Cha, 785 times, ₹6,250" is something
 * a person can act on. This is why the taxonomy keeps products rather than
 * collapsing everything into sectors.
 */
export async function getTopProducts(
  month: string,
  limit = 10,
): Promise<MonthlyProductSpend[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("v_monthly_product_spend")
    .select("*")
    .eq("month", month)
    .order("spend", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getTopProducts:", error.message);
    return [];
  }
  return (data as MonthlyProductSpend[]) ?? [];
}

/** The most recent month that has any data, or null for an empty ledger. */
export function latestMonth(coverage: MonthlyCoverage[]): string | null {
  if (coverage.length === 0) return null;
  return coverage[coverage.length - 1].month;
}
