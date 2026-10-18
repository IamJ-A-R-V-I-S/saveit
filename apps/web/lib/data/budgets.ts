import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { BudgetStatus, GoalStatusRow } from "@/lib/types";

/**
 * Budgets and goals.
 *
 * Both exist because the coach needs something to aim at. A budget is a ceiling
 * per sector; a goal is a target with a deadline. `v_budget_status` and
 * `v_goal_status` attach actuals so the UI never has to compute "how much of
 * this month is left" itself.
 */

export async function getBudgets(): Promise<BudgetStatus[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("v_budget_status")
    .select("*")
    .eq("period", "monthly")
    .order("pct_used", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("getBudgets:", error.message);
    return [];
  }
  return (data as BudgetStatus[]) ?? [];
}

export async function getGoals(): Promise<GoalStatusRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("v_goal_status")
    .select("*")
    .order("status", { ascending: true })
    .order("days_left", { ascending: true, nullsFirst: false });

  if (error) {
    console.error("getGoals:", error.message);
    return [];
  }
  return (data as GoalStatusRow[]) ?? [];
}

/**
 * Budgets that are close to or over their ceiling.
 *
 * Computed here rather than in SQL because "close" is a display threshold, and
 * `pct_used` can be null for a zero budget (the view guards against division by
 * zero) — those must not be reported as overspent.
 */
export function budgetsAtRisk(budgets: BudgetStatus[]): BudgetStatus[] {
  return budgets.filter((b) => {
    const pct = Number(b.pct_used);
    return Number.isFinite(pct) && pct >= 80;
  });
}
