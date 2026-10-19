"use server";

import { revalidatePath } from "next/cache";
import { createClient, currentUser } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/actions/auth";
import type { BudgetPeriod } from "@/lib/types";

/**
 * Budget and goal mutations.
 *
 * Both give the coach a target to measure against. Without them it can only say
 * "you spent ₹6,250 on Cha", which is a description; with a budget it can say
 * "you are 40% over on Eating Out with nine days left", which is a nudge.
 */

const PERIODS: BudgetPeriod[] = ["weekly", "monthly", "quarterly", "yearly"];

export async function setBudget(formData: FormData): Promise<ActionResult> {
  const sectorSlug = String(formData.get("sectorSlug") ?? "");
  const amount = Number(String(formData.get("amount") ?? ""));
  const period = (String(formData.get("period") ?? "monthly") || "monthly") as BudgetPeriod;

  if (!sectorSlug) return { ok: false, error: "Choose a sector." };
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Enter a budget of zero or more." };
  }
  if (!PERIODS.includes(period)) return { ok: false, error: "That period isn't supported." };

  const supabase = await createClient();
  const user = await currentUser();
  if (!user) return { ok: false, error: "You are signed out." };

  const { data: sector } = await supabase
    .from("sectors")
    .select("id")
    .eq("slug", sectorSlug)
    .maybeSingle();
  if (!sector?.id) return { ok: false, error: `Unknown sector "${sectorSlug}".` };

  // One budget per (user, sector, period) — enforced by
  // `budgets_user_sector_period_idx`. Upserting means "set a budget" is one
  // action whether or not one already exists.
  const { error } = await supabase.from("budgets").upsert(
    { user_id: user.id, sector_id: sector.id, period, amount },
    { onConflict: "user_id,sector_id,period" },
  );

  if (error) return { ok: false, error: error.message };

  revalidatePath("/budgets");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteBudget(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("budgets").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/budgets");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function createGoal(formData: FormData): Promise<ActionResult> {
  const name = String(formData.get("name") ?? "").trim();
  const target = Number(String(formData.get("targetAmount") ?? ""));
  const deadline = String(formData.get("deadline") ?? "").trim() || null;

  if (!name) return { ok: false, error: "Give the goal a name." };
  if (!Number.isFinite(target) || target <= 0) {
    return { ok: false, error: "The target must be greater than zero." };
  }
  if (deadline && Number.isNaN(new Date(deadline).getTime())) {
    return { ok: false, error: "That deadline isn't a valid date." };
  }

  const supabase = await createClient();
  const user = await currentUser();
  if (!user) return { ok: false, error: "You are signed out." };

  const { error } = await supabase.from("goals").insert({
    user_id: user.id,
    name,
    target_amount: target,
    saved_amount: 0,
    deadline,
    status: "active",
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/budgets");
  return { ok: true };
}

/**
 * Record progress against a goal.
 *
 * Deliberately an absolute value, not an increment. Savings are usually moved
 * in one go, and an absolute set is idempotent — a double-clicked button cannot
 * double-count, which an `saved_amount = saved_amount + n` update would.
 */
export async function setGoalProgress(id: string, savedAmount: number): Promise<ActionResult> {
  if (!Number.isFinite(savedAmount) || savedAmount < 0) {
    return { ok: false, error: "Enter an amount of zero or more." };
  }

  const supabase = await createClient();

  const { data: goal } = await supabase
    .from("goals")
    .select("target_amount")
    .eq("id", id)
    .maybeSingle();
  if (!goal) return { ok: false, error: "That goal no longer exists." };

  const target = Number(goal.target_amount);
  const status = Number.isFinite(target) && savedAmount >= target ? "reached" : "active";

  const { error } = await supabase
    .from("goals")
    .update({ saved_amount: savedAmount, status })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/budgets");
  return { ok: true };
}

export async function deleteGoal(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("goals").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/budgets");
  return { ok: true };
}
