"use server";

import { revalidatePath } from "next/cache";
import { callFunction, describeEdgeError } from "@/lib/edge";
import { createClient, currentUser } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/actions/auth";

/**
 * Profile and notification settings.
 *
 * Telegram is the delivery channel because it needs no approval process and no
 * paid provider — a bot token plus a chat id, both free, both instant. The chat
 * id lives on the profile rather than in an environment variable because this is
 * multi-tenant: every user gets their own.
 */

export async function updateProfile(formData: FormData): Promise<ActionResult> {
  const fullName = String(formData.get("fullName") ?? "").trim() || null;
  const currency = String(formData.get("currency") ?? "INR").trim().toUpperCase() || "INR";
  const capRaw = Number(String(formData.get("llmDailyCap") ?? ""));

  if (currency.length !== 3) return { ok: false, error: "Currency must be a 3-letter code." };
  // The column has `check (llm_daily_cap > 0)`; sending 0 would fail in the
  // database with a message about a constraint, which reads like a bug.
  if (Number.isFinite(capRaw) && capRaw <= 0) {
    return { ok: false, error: "The daily model-call cap must be at least 1." };
  }

  const supabase = await createClient();
  const user = await currentUser();
  if (!user) return { ok: false, error: "You are signed out." };

  const patch: Record<string, unknown> = { full_name: fullName, default_currency: currency };
  if (Number.isFinite(capRaw) && capRaw > 0) patch.llm_daily_cap = Math.round(capRaw);

  const { error } = await supabase.from("profiles").update(patch).eq("id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Save a Telegram chat id and switch delivery on or off.
 *
 * The chat id is validated as digits because that is what Telegram uses, and a
 * typo here fails silently much later — when the coach tries to push and gets a
 * 400 from the Telegram API, with no feedback in the app.
 */
export async function saveTelegramSettings(formData: FormData): Promise<ActionResult> {
  const chatId = String(formData.get("chatId") ?? "").trim();
  const enabled = formData.get("enabled") === "on";

  if (enabled && chatId && !/^-?\d{5,20}$/.test(chatId)) {
    return {
      ok: false,
      error: "That doesn't look like a Telegram chat id. It's a long number — message @userinfobot on Telegram to get yours.",
    };
  }

  const supabase = await createClient();
  const user = await currentUser();
  if (!user) return { ok: false, error: "You are signed out." };

  const { error } = await supabase
    .from("profiles")
    .update({
      telegram_chat_id: chatId || null,
      // Enabling delivery with no chat id would make every coach run fail at
      // the notify step, so the flag only turns on when there is somewhere to
      // send to.
      telegram_enabled: enabled && Boolean(chatId),
    })
    .eq("id", user.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Send a test message so the user knows delivery works before waiting a month
 * for the coach to find something.
 */
export async function sendTelegramTest(): Promise<ActionResult> {
  try {
    await callFunction("notify", { body: { test: true }, timeoutMs: 30_000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeEdgeError(err) };
  }
}

/** Complete the first-run setup so the app stops showing the empty state. */
export async function markOnboarded(): Promise<ActionResult> {
  const supabase = await createClient();
  const user = await currentUser();
  if (!user) return { ok: false, error: "You are signed out." };

  const { error } = await supabase
    .from("profiles")
    .update({ onboarded: true })
    .eq("id", user.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  return { ok: true };
}
