"use client";

import { useState, useTransition } from "react";
import {
  createGoal,
  deleteBudget,
  deleteGoal,
  setBudget,
  setGoalProgress,
} from "@/lib/actions/budgets";
import { cx } from "@/components/ui";
import { money, num } from "@/lib/format";
import type { Sector } from "@/lib/types";

/** Budget and goal forms. */

type Feedback = { tone: "ok" | "err"; text: string } | null;

function Banner({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role="status"
      className={cx(
        "mt-3 rounded-lg border px-3 py-2 text-xs",
        feedback.tone === "ok"
          ? "border-success/25 bg-success-soft text-success"
          : "border-danger/25 bg-danger-soft text-danger",
      )}
    >
      {feedback.text}
    </p>
  );
}

export function BudgetForm({
  sectors,
  existing,
}: {
  sectors: Sector[];
  existing: Map<string, { id: string; amount: number }>;
}) {
  const [sectorSlug, setSectorSlug] = useState("");
  const [amount, setAmount] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  async function submit(formData: FormData) {
    setFeedback(null);
    startTransition(async () => {
      const result = await setBudget(formData);
      setFeedback(
        result.ok
          ? { tone: "ok", text: "Budget saved." }
          : { tone: "err", text: result.error },
      );
    });
  }

  const isEditing = existing.has(sectorSlug);

  return (
    <form action={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="budget-sector">
          Sector
        </label>
        <select
          id="budget-sector"
          name="sectorSlug"
          className="field"
          required
          value={sectorSlug}
          onChange={(e) => {
            const slug = e.target.value;
            setSectorSlug(slug);
            // Pre-fill the existing limit so editing one does not start from a
            // blank field and silently zero it out.
            const current = existing.get(slug);
            setAmount(current ? String(current.amount) : "");
          }}
        >
          <option value="" disabled>
            Choose a sector…
          </option>
          {sectors.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.icon ? `${s.icon} ` : ""}
              {s.name}
              {existing.has(s.slug) ? ` — currently ${money(existing.get(s.slug)!.amount)}` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="budget-amount">
            Monthly limit
          </label>
          <input
            id="budget-amount"
            name="amount"
            type="number"
            min="0"
            step="100"
            required
            className="field tnum"
            placeholder="8000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <input type="hidden" name="period" value="monthly" />
        <div className="flex items-end">
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Saving…" : isEditing ? "Update budget" : "Save budget"}
          </button>
        </div>
      </div>

      <Banner feedback={feedback} />
    </form>
  );
}

export function DeleteBudgetButton({ id, label }: { id: string; label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        title={`Remove the ${label} budget`}
        onClick={() => {
          if (!window.confirm(`Remove the ${label} budget?`)) return;
          setError(null);
          startTransition(async () => {
            const result = await deleteBudget(id);
            if (!result.ok) setError(result.error);
          });
        }}
        className="rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-sunken hover:text-danger disabled:opacity-50"
      >
        remove
      </button>
      {error ? <span className="text-[10px] text-danger">{error}</span> : null}
    </span>
  );
}

export function GoalForm() {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  async function submit(formData: FormData) {
    setFeedback(null);
    startTransition(async () => {
      const result = await createGoal(formData);
      if (!result.ok) {
        setFeedback({ tone: "err", text: result.error });
        return;
      }
      setFeedback({ tone: "ok", text: "Goal created." });
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line-strong px-3.5 py-2 text-sm font-semibold text-ink hover:bg-surface"
      >
        + New goal
      </button>
    );
  }

  return (
    <form action={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="goal-name">
          What are you saving for?
        </label>
        <input
          id="goal-name"
          name="name"
          required
          autoFocus
          className="field"
          placeholder="Emergency fund, a trip, a laptop…"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="goal-target">
            Target
          </label>
          <input
            id="goal-target"
            name="targetAmount"
            type="number"
            min="1"
            step="1000"
            required
            className="field tnum"
            placeholder="100000"
          />
        </div>
        <div>
          <label className="label" htmlFor="goal-deadline">
            By when <span className="font-normal text-faint">(optional)</span>
          </label>
          <input id="goal-deadline" name="deadline" type="date" className="field tnum" />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Create goal"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
      <Banner feedback={feedback} />
    </form>
  );
}

/**
 * Record progress against a goal.
 *
 * Absolute, not incremental: savings usually move in one go, and an absolute set
 * is idempotent — a double-clicked button cannot double-count, which a
 * `saved_amount = saved_amount + n` update would.
 */
export function GoalProgressForm({
  id,
  target,
  saved,
}: {
  id: string;
  target: number;
  saved: number;
}) {
  const [value, setValue] = useState(String(saved));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dirty = num(value) !== saved;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await setGoalProgress(id, num(value));
          if (!result.ok) setError(result.error);
        });
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <label className="text-[11px] text-muted" htmlFor={`saved-${id}`}>
        Saved so far
      </label>
      <input
        id={`saved-${id}`}
        type="number"
        min="0"
        step="100"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="field tnum w-28 py-1 text-xs"
      />
      {dirty ? (
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "…" : "Update"}
        </button>
      ) : null}
      {error ? <span className="text-[11px] text-danger">{error}</span> : null}
      <span className="text-[11px] text-faint">of {money(target)}</span>
    </form>
  );
}

export function DeleteGoalButton({ id, name }: { id: string; name: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Delete the goal “${name}”?`)) return;
        startTransition(async () => {
          await deleteGoal(id);
        });
      }}
      className="rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-sunken hover:text-danger disabled:opacity-50"
    >
      delete
    </button>
  );
}
