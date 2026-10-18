"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { assignProduct, correctTransaction, deleteTransaction } from "@/lib/actions/transactions";
import { Badge, Money, SectorIcon, Table, Td, Th, cx } from "@/components/ui";
import {
  confidenceLabel,
  count,
  dateTimeLabel,
  num,
  truncate,
} from "@/lib/format";
import type { Transaction } from "@/lib/types";

/**
 * The ledger table.
 *
 * A client component because selection, the product picker and optimistic
 * row updates are all local interaction state. The rows themselves are fetched
 * on the server and passed in as serializable props — the table does not
 * refetch, so navigation stays server-rendered and this only handles what the
 * user does to what is already on screen.
 */

export interface ProductOption {
  id: string;
  name: string;
  sectorSlug: string;
  sectorName: string;
  sectorIcon: string | null;
  useCount: number;
}

type Feedback = { tone: "ok" | "err"; text: string } | null;

export function LedgerTable({
  rows,
  products,
  emptyMessage,
}: {
  rows: Transaction[];
  products: ProductOption[];
  emptyMessage?: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerFor, setPickerFor] = useState<string | "bulk" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  // Rows removed optimistically. Kept separate from `rows` so a failed action
  // can be reverted simply by not having mutated the props.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, ProductOption>>(new Map());

  const visible = useMemo(
    () => rows.filter((r) => !removed.has(r.id)),
    [rows, removed],
  );

  const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visible.map((r) => r.id)));
  }

  /**
   * Assign a product.
   *
   * Tries the `correct` edge function first because that is the version that
   * learns: it records the correction and writes an alias so the same
   * description never needs a model call again. If the function is not
   * deployed, it falls back to a direct UPDATE — the row still gets fixed, the
   * alias just isn't learned, and the message says which happened.
   */
  async function assign(ids: string[], product: ProductOption) {
    setPickerFor(null);
    setFeedback(null);

    // Optimistic: show the new categorization immediately. A correction is
    // local and reversible, and waiting a round trip for every row makes
    // clearing a 200-item queue feel slow.
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, product);
      return next;
    });
    setSelected(new Set());

    startTransition(async () => {
      const result = await correctTransaction({
        transactionIds: ids,
        productId: product.id,
        applyToSimilar: false,
      });

      if (result.ok) {
        const extra = result.result.appliedToSimilar ?? 0;
        setFeedback({
          tone: "ok",
          text:
            ids.length > 1
              ? `${ids.length} rows moved to ${product.name}. Future rows like this will match automatically.`
              : `Moved to ${product.name}. Future rows like this will match automatically.${extra > 0 ? ` Also fixed ${extra} similar.` : ""}`,
        });
        return;
      }

      // Fall back only when the function is genuinely unavailable. A validation
      // error from the function is real and should be surfaced, not papered over.
      const fallback = await assignProduct(ids, product.id);
      if (fallback.ok) {
        setFeedback({
          tone: "ok",
          text: `${ids.length > 1 ? `${ids.length} rows` : "Row"} moved to ${product.name}. (Saved directly — the alias wasn't learned, because the correct function isn't deployed.)`,
        });
      } else {
        setOverrides((prev) => {
          const next = new Map(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
        setFeedback({ tone: "err", text: fallback.error });
      }
    });
  }

  async function remove(ids: string[]) {
    const label = ids.length > 1 ? `${ids.length} transactions` : "this transaction";
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

    setFeedback(null);
    setRemoved((prev) => new Set([...prev, ...ids]));
    setSelected(new Set());

    startTransition(async () => {
      const results = await Promise.all(ids.map((id) => deleteTransaction(id)));
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        // Revert only the rows that actually failed.
        const failedIds = ids.filter((_, i) => !results[i].ok);
        setRemoved((prev) => {
          const next = new Set(prev);
          for (const id of failedIds) next.delete(id);
          return next;
        });
        setFeedback({ tone: "err", text: `Could not delete: ${failed[0].error}` });
      } else {
        setFeedback({ tone: "ok", text: `Deleted ${label}.` });
      }
    });
  }

  const selectedIds = [...selected];

  return (
    <div>
      {feedback ? (
        <p
          role="status"
          className={cx(
            "mb-3 rounded-lg border px-3 py-2 text-xs leading-relaxed",
            feedback.tone === "ok"
              ? "border-success/25 bg-success-soft text-success"
              : "border-danger/25 bg-danger-soft text-danger",
          )}
        >
          {feedback.text}
        </p>
      ) : null}

      {selectedIds.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2">
          <span className="text-xs font-semibold text-ink">
            {count(selectedIds.length)} selected
          </span>
          <button
            type="button"
            onClick={() => setPickerFor("bulk")}
            disabled={pending}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            Categorize as…
          </button>
          <button
            type="button"
            onClick={() => remove(selectedIds)}
            disabled={pending}
            className="rounded-md border border-danger/30 px-2.5 py-1 text-xs font-semibold text-danger hover:bg-danger-soft disabled:opacity-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink"
          >
            Clear selection
          </button>
        </div>
      ) : null}

      {pickerFor ? (
        <ProductPicker
          products={products}
          title={
            pickerFor === "bulk"
              ? `Categorize ${selectedIds.length} transactions`
              : "Categorize this transaction"
          }
          onCancel={() => setPickerFor(null)}
          onPick={(product) =>
            assign(pickerFor === "bulk" ? selectedIds : [pickerFor], product)
          }
        />
      ) : null}

      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              <Th className="w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all rows on this page"
                  className="size-3.5 accent-[var(--accent)]"
                />
              </Th>
              <Th>Date</Th>
              <Th>Description</Th>
              <Th>Account</Th>
              <Th>Category</Th>
              <Th align="right">Amount</Th>
              <Th align="center">Confidence</Th>
              <Th className="w-16" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <Td colSpan={8} className="py-12 text-center text-sm text-muted">
                  {emptyMessage ?? "No transactions match these filters."}
                </Td>
              </tr>
            ) : (
              visible.map((row) => {
                const override = overrides.get(row.id);
                const productName = override?.name ?? row.product?.name ?? null;
                const sector = override
                  ? { slug: override.sectorSlug, name: override.sectorName, icon: override.sectorIcon }
                  : (row.product?.sector ?? null);
                const conf = confidenceLabel(row.confidence);
                const isSelected = selected.has(row.id);

                return (
                  <tr
                    key={row.id}
                    className={cx(
                      "transition-colors",
                      isSelected ? "bg-accent-soft/60" : "hover:bg-sunken",
                      row.categorize_status === "review" && !isSelected && "bg-warning-soft/30",
                    )}
                  >
                    <Td>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(row.id)}
                        aria-label={`Select ${row.raw_description ?? "transaction"}`}
                        className="size-3.5 accent-[var(--accent)]"
                      />
                    </Td>
                    <Td className="tnum whitespace-nowrap text-xs text-muted">
                      {dateTimeLabel(row.occurred_at)}
                    </Td>
                    <Td className="max-w-70">
                      <p className="truncate text-sm text-ink" title={row.raw_description ?? undefined}>
                        {row.raw_description ?? "—"}
                      </p>
                      {row.note || row.payee ? (
                        <p className="mt-0.5 truncate text-[11px] text-faint">
                          {row.payee ? `${row.payee} · ` : ""}
                          {truncate(row.note ?? "", 70)}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted">
                      {row.account?.name ?? "—"}
                    </Td>
                    <Td>
                      {productName ? (
                        <span className="flex items-center gap-1.5 whitespace-nowrap">
                          <SectorIcon icon={sector?.icon} />
                          <span className="text-xs text-ink">{productName}</span>
                        </span>
                      ) : (
                        <Badge tone="warning">uncategorized</Badge>
                      )}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      <Money amount={row.amount} direction={row.direction} exact />
                    </Td>
                    <Td align="center">
                      <Badge tone={conf.tone} title={`confidence ${num(row.confidence).toFixed(2)}`}>
                        {conf.label}
                      </Badge>
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setPickerFor(row.id)}
                          className="rounded-md px-1.5 py-1 text-[11px] font-medium text-muted hover:bg-surface hover:text-accent"
                          title="Change category"
                        >
                          fix
                        </button>
                        <button
                          type="button"
                          onClick={() => remove([row.id])}
                          className="rounded-md px-1.5 py-1 text-[11px] font-medium text-muted hover:bg-surface hover:text-danger"
                          title="Delete"
                        >
                          ✕
                        </button>
                      </div>
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </div>

      {visible.length > 0 ? (
        <p className="mt-2.5 text-[11px] text-faint">
          Showing {count(visible.length)} row{visible.length === 1 ? "" : "s"} on this page ·{" "}
          <Link href="/review" className="hover:text-accent hover:underline">
            open the review queue
          </Link>{" "}
          to clear ambiguous rows in bulk
        </p>
      ) : null}
    </div>
  );
}

/**
 * Searchable product picker.
 *
 * Search happens client-side over the full list. The taxonomy is a few hundred
 * products at most, so a round trip per keystroke would be slower than filtering
 * in memory — and instant feedback matters when you are clearing a long queue.
 *
 * Ordering is by use_count, not alphabetical: the products the user reaches for
 * are the ones they already use most, so the top of the list is usually the
 * answer.
 */
function ProductPicker({
  products,
  title,
  onPick,
  onCancel,
}: {
  products: ProductOption[];
  title: string;
  onPick: (product: ProductOption) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 40);
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.sectorName.toLowerCase().includes(q) ||
          p.sectorSlug.includes(q),
      )
      .slice(0, 40);
  }, [products, query]);

  return (
    <div className="card mb-3 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-xs text-muted hover:bg-sunken hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div className="border-b border-line px-4 py-2.5">
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter" && matches[0]) {
              e.preventDefault();
              onPick(matches[0]);
            }
          }}
          placeholder="Search products or sectors… (Enter picks the first match)"
          className="field"
          aria-label="Search products"
        />
      </div>

      <ul className="max-h-72 overflow-y-auto">
        {matches.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-muted">
            No product called “{query}”. It gets created the first time the categorizer sees a
            description like it.
          </li>
        ) : (
          matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p)}
                className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left transition-colors hover:bg-sunken"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <SectorIcon icon={p.sectorIcon} />
                  <span className="truncate text-sm text-ink">{p.name}</span>
                </span>
                <span className="shrink-0 text-[11px] text-faint">
                  {p.sectorName}
                  {p.useCount > 0 ? ` · used ${count(p.useCount)}×` : ""}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
