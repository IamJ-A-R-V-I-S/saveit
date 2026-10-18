"use client";

import { useState, useTransition } from "react";
import { addTransaction } from "@/lib/actions/transactions";
import { cx } from "@/components/ui";
import type { ProductOption } from "@/components/transactions/ledger-table";

/**
 * Manual entry.
 *
 * Statements miss things — cash handed to someone, a split bill, a subscription
 * paid from an account you never export. Without manual entry the ledger is only
 * as complete as the exports, and the coach would confidently report savings
 * that are really just missing rows.
 *
 * Defaults to today and to spend, because that is what a person typing an
 * expense right now almost always means.
 */
export function AddTransactionForm({
  products,
  accounts,
  onDone,
}: {
  products: ProductOption[];
  accounts: { id: string; name: string }[];
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ProductOption | null>(null);
  const [pending, startTransition] = useTransition();

  const today = new Date().toISOString().slice(0, 10);

  const matches = query.trim()
    ? products
        .filter(
          (p) =>
            p.name.toLowerCase().includes(query.trim().toLowerCase()) ||
            p.sectorName.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .slice(0, 6)
    : [];

  async function submit(formData: FormData) {
    setError(null);
    setSaved(false);

    if (picked) formData.set("productId", picked.id);

    startTransition(async () => {
      const result = await addTransaction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      setQuery("");
      setPicked(null);
      onDone?.();
      // Stay open. Manual entry is usually several rows in a row — closing the
      // form after each one makes recording a week of cash spending tedious.
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line-strong px-3.5 py-2 text-sm font-semibold text-ink transition-colors hover:bg-surface"
      >
        + Add manually
      </button>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h3 className="text-sm font-semibold">Add a transaction</h3>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
            setSaved(false);
          }}
          className="rounded-md px-2 py-1 text-xs text-muted hover:bg-sunken hover:text-ink"
        >
          Close
        </button>
      </div>

      <form action={submit} className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="lg:col-span-2">
          <label className="label" htmlFor="description">
            Description
          </label>
          <input
            id="description"
            name="description"
            required
            className="field"
            placeholder="Auto, lunch, rent…"
            autoComplete="off"
          />
        </div>

        <div>
          <label className="label" htmlFor="amount">
            Amount
          </label>
          <input
            id="amount"
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            className="field tnum"
            placeholder="0.00"
          />
        </div>

        <div>
          <label className="label" htmlFor="occurredAt">
            Date
          </label>
          <input id="occurredAt" name="occurredAt" type="date" defaultValue={today} required className="field tnum" />
        </div>

        <div>
          <label className="label" htmlFor="direction">
            Type
          </label>
          <select id="direction" name="direction" className="field" defaultValue="debit">
            <option value="debit">Spend</option>
            <option value="credit">Income</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="accountId">
            Account
          </label>
          <select id="accountId" name="accountId" className="field" defaultValue="">
            <option value="">Manual entry</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div className="relative sm:col-span-2 lg:col-span-3">
          <label className="label" htmlFor="product-search">
            Category <span className="font-normal text-faint">(optional)</span>
          </label>
          <input
            id="product-search"
            type="search"
            className="field"
            value={picked ? picked.name : query}
            onChange={(e) => {
              setPicked(null);
              setQuery(e.target.value);
            }}
            placeholder={picked ? picked.name : "Leave blank to categorize later"}
            autoComplete="off"
          />
          {matches.length > 0 && !picked ? (
            <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-pop">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked(p);
                      setQuery("");
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-sunken"
                  >
                    <span>{p.name}</span>
                    <span className="text-[11px] text-faint">{p.sectorName}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <label className="label" htmlFor="note">
            Note <span className="font-normal text-faint">(optional)</span>
          </label>
          <input id="note" name="note" type="text" className="field" placeholder="Who it was for, what it covered" />
        </div>

        {error ? (
          <p role="alert" className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger lg:col-span-6">
            {error}
          </p>
        ) : null}

        {saved ? (
          <p role="status" className="rounded-lg border border-success/25 bg-success-soft px-3 py-2 text-xs text-success lg:col-span-6">
            Saved. Add another, or close.
          </p>
        ) : null}

        <div className="flex items-center gap-2 lg:col-span-6">
          <button
            type="submit"
            disabled={pending}
            className={cx(
              "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <span className="text-[11px] text-faint">
            Deduped against your ledger, so typing something you also imported won&apos;t double-count.
          </span>
        </div>
      </form>
    </div>
  );
}
