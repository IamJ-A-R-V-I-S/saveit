"use client";

import { useState, useTransition } from "react";
import { sendTelegramTest, updateProfile, saveTelegramSettings } from "@/lib/actions/profile";
import { signOut } from "@/lib/actions/auth";
import { cx } from "@/components/ui";
import type { ProfileRow } from "@/lib/types";

type Feedback = { tone: "ok" | "err"; text: string } | null;

function Banner({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role="status"
      className={cx(
        "mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed",
        feedback.tone === "ok"
          ? "border-success/25 bg-success-soft text-success"
          : "border-danger/25 bg-danger-soft text-danger",
      )}
    >
      {feedback.text}
    </p>
  );
}

export function ProfileForm({ profile }: { profile: ProfileRow | null }) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  async function submit(formData: FormData) {
    setFeedback(null);
    startTransition(async () => {
      const result = await updateProfile(formData);
      setFeedback(result.ok ? { tone: "ok", text: "Saved." } : { tone: "err", text: result.error });
    });
  }

  return (
    <form action={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="fullName">
          Name
        </label>
        <input
          id="fullName"
          name="fullName"
          type="text"
          autoComplete="name"
          defaultValue={profile?.full_name ?? ""}
          className="field"
          placeholder="Used in the coach's Telegram messages"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="currency">
            Currency
          </label>
          <input
            id="currency"
            name="currency"
            type="text"
            maxLength={3}
            defaultValue={profile?.default_currency ?? "INR"}
            className="field tnum uppercase"
          />
          <p className="mt-1.5 text-[11px] text-faint">
            Amounts are displayed in Indian grouping regardless.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="llmDailyCap">
            Daily model-call cap
          </label>
          <input
            id="llmDailyCap"
            name="llmDailyCap"
            type="number"
            min="1"
            max="5000"
            defaultValue={profile?.llm_daily_cap ?? 200}
            className="field tnum"
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            A ceiling on model calls per day, so a 5,000-page PDF cannot exhaust a free-tier quota
            mid-month. Deterministic matches don&apos;t count against it.
          </p>
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save profile"}
      </button>

      <Banner feedback={feedback} />
    </form>
  );
}

export function TelegramForm({ profile }: { profile: ProfileRow | null }) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  async function submit(formData: FormData) {
    setFeedback(null);
    startTransition(async () => {
      const result = await saveTelegramSettings(formData);
      setFeedback(
        result.ok
          ? { tone: "ok", text: "Saved. Send a test message to confirm delivery." }
          : { tone: "err", text: result.error },
      );
    });
  }

  async function test() {
    setFeedback(null);
    startTransition(async () => {
      const result = await sendTelegramTest();
      setFeedback(
        result.ok
          ? { tone: "ok", text: "Test message sent — check Telegram." }
          : { tone: "err", text: result.error },
      );
    });
  }

  return (
    <div className="space-y-4">
      <form action={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="chatId">
            Telegram chat id
          </label>
          <input
            id="chatId"
            name="chatId"
            type="text"
            inputMode="numeric"
            defaultValue={profile?.telegram_chat_id ?? ""}
            className="field tnum font-mono"
            placeholder="123456789"
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            Message <span className="font-mono">@userinfobot</span> on Telegram to get yours. It is
            stored on your profile, not in an environment variable, because every user has their own.
          </p>
        </div>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={profile?.telegram_enabled ?? false}
            className="mt-0.5 size-4 accent-[var(--accent)]"
          />
          <span>
            <span className="block text-sm font-medium text-ink">Send me coach insights</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-faint">
              Only turns on once a chat id is saved. Enabling delivery with nowhere to send it would
              make every scheduled run fail.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={pending || !profile?.telegram_chat_id}
            className="rounded-lg border border-line-strong px-4 py-2 text-sm font-semibold text-ink hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send a test message
          </button>
        </div>

        <Banner feedback={feedback} />
      </form>

      <div className="rounded-lg bg-sunken px-3 py-2.5 text-[11px] leading-relaxed text-muted">
        <p className="font-semibold text-ink">Setting the bot up</p>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
          <li>
            Talk to <span className="font-mono">@BotFather</span> on Telegram, create a bot, copy its
            token.
          </li>
          <li>
            Set it as the <span className="font-mono">TELEGRAM_BOT_TOKEN</span> secret on the
            Supabase project.
          </li>
          <li>Send your new bot any message once, then get your chat id and paste it above.</li>
        </ol>
      </div>
    </div>
  );
}

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="rounded-lg border border-danger/30 px-4 py-2 text-sm font-semibold text-danger hover:bg-danger-soft"
      >
        Sign out
      </button>
    </form>
  );
}
