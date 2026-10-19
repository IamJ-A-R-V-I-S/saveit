"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { categorizePending } from "@/lib/actions/upload";
import { assignProduct, correctTransaction } from "@/lib/actions/transactions";
import { Badge, Card, CardBody, CardHeader, SectorIcon, cx } from "@/components/ui";
import { count, dateLabel, money, num, truncate } from "@/lib/format";
import type { ProductOption } from "@/components/transactions/ledger-table";
import type { Transaction } from "@/lib/types";

/**
 * The review queue.
 *
 * Rows land here for two different reasons and the UI keeps them apart:
 *
 *  - NOTHING MATCHED. The resolver has never seen this description. Grouping by
 *    description matters most here — `Cha` appearing 785 times is one decision,
 *    not 785.
 *  - SOMETHING MATCHED, AMBIGUOUSLY. An exact hit on a product in a deliberately
 *    broad sector. `Charges, Fees` matches at 0.99 but covers exam fees,
 *    brokerage, a maid and a freelancer in the sample data. Auto-accepting it
 *    would produce a ledger that looks confident and is wrong.
 *
 * Correcting from here goes through the `correct` edge function with
 * `applyToSimilar`, which writes an alias. That is the point of the queue: every
 * decision makes the next upload cheaper and more accurate, so the queue drains
 * over time instead of refilling.
 */

export interface ReviewCluster {
  description: string;
  rows: Transaction[];
  total: number;
  first: string | null;
  last: string | null;
  /** An exact match exists but the sector is too broad to trust. */
  suggestion: ProductOption | null;
  confidence: number;
}

type Feedback = { tone: "ok" | "err"; text: string } | null;

export function ReviewQueue({
  clusters,
  products,
  pendingCount,
}: {
  clusters: ReviewCluster[];
  products: ProductOption[];
  pendingCount: number;
}) {
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const open = useMemo(
    () => clusters.filter((c) => !resolved.has(c.description)),
    [clusters, resolved],
  );

  const totalRows = open.reduce((n, c) => n + c.rows.length, 0);
  const totalValue = open.reduce((n, c) => n + c.total, 0);

  async function decide(description: string, ids: string[], product: ProductOption) {
    setPickerFor(null);
    setFeedback(null);

    startTransition(async () => {
      const result = await correctTransaction({
        transactionIds: ids,
        productId: product.id,
        // Fix every other row with this description in one go. Without it,
        // clearing 785 `Cha` rows means 785 decisions.
        applyToSimilar: true,
      });

      if (result.ok) {
        setResolved((prev) => new Set([...prev, description]));
        const extra = result.result.appliedToSimilar ?? 0;
        setFeedback({
          tone: "ok",
          text: `${count(ids.length)} row${ids.length === 1 ? "" : "s"} → ${product.name}.${
            extra > 0 ? ` Also fixed ${count(extra)} similar row${extra === 1 ? "" : "s"}.` : ""
          } Future rows matching “${truncate(description, 30)}” will categorize themselves.`,
        });
        return;
      }

      // The function may not be deployed yet. Fall back to a direct update so
      // the queue is still usable, and say plainly that nothing was learned.
      const fallback = await assignProduct(ids, product.id);
      if (fallback.ok) {
        setResolved((prev) => new Set([...prev, description]));
        setFeedback({
          tone: "ok",
          text: `${count(ids.length)} row${ids.length === 1 ? "" : "s"} → ${product.name}. Saved directly — no alias was learned, because the correct function isn't deployed.`,
        });
      } else {
        setFeedback({ tone: "err", text: fallback.error });
      }
    });
  }

  async function runCategorizer() {
    setFeedback(null);
    startTransition(async () => {
      const result = await categorizePending({ limit: 200 });
      setFeedback(
        result.ok
          ? {
              tone: "ok",
              text:
                result.categorized > 0
                  ? `Categorized ${count(result.categorized)} row${result.categorized === 1 ? "" : "s"}.`
                  : "Nothing was waiting on the model.",
            }
          : { tone: "err", text: result.error },
      );
    });
  }

  return (
    <div className="space-y-4">
      {feedback ? (
        <p
          role="status"
          className={cx(
            "rounded-lg border px-3 py-2.5 text-xs leading-relaxed",
            feedback.tone === "ok"
              ? "border-success/25 bg-success-soft text-success"
              : "border-danger/25 bg-danger-soft text-danger",
          )}
        >
          {feedback.text}
        </p>
      ) : null}

      {pendingCount > 0 ? (
        <Card className="border-info/30">
          <CardBody className="flex flex-wrap items-center justify-between gap-3 py-3">
            <p className="text-sm">
              <strong className="font-semibold text-ink">{count(pendingCount)} rows</strong>{" "}
              <span className="text-muted">
                are waiting on the model, not on you. These are descriptions the deterministic
                resolver could not place.
              </span>
            </p>
            <button
              type="button"
              onClick={runCategorizer}
              disabled={pending}
              className="rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
            >
              {pending ? "Working…" : "Categorize now"}
            </button>
          </CardBody>
        </Card>
      ) : null}

      {open.length === 0 ? (
        <Card>
          <CardBody className="py-14 text-center">
            <p className="text-3xl" aria-hidden>
              ✓
            </p>
            <p className="mt-3 text-sm font-semibold text-ink">The queue is clear</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted">
              Every row your ledger holds has a category you or the resolver are confident in. New
              uploads will land here only when they contain something genuinely new.
            </p>
            <Link
              href="/dashboard"
              className="mt-5 inline-block rounded-lg border border-line-strong px-4 py-2 text-sm font-semibold hover:bg-sunken"
            >
              Back to dashboard
            </Link>
          </CardBody>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted">
            {count(open.length)} description{open.length === 1 ? "" : "s"} covering{" "}
            <strong className="font-semibold text-ink">{count(totalRows)} rows</strong> and{" "}
            <strong className="font-semibold text-ink">{money(totalValue)}</strong>. Deciding one
            description decides every row like it.
          </p>

          <ul className="space-y-3">
            {open.map((cluster) => {
              const ids = cluster.rows.map((r) => r.id);
              const isSuggestion = cluster.suggestion !== null;

              return (
                <li key={cluster.description}>
                  <Card>
                    <CardHeader
                      title={
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm">{cluster.description}</span>
                          {isSuggestion ? (
                            <Badge tone="warning" title={`matched at ${cluster.confidence.toFixed(2)}`}>
                              ambiguous match
                            </Badge>
                          ) : (
                            <Badge tone="danger">no match</Badge>
                          )}
                        </span>
                      }
                      hint={
                        <>
                          {count(cluster.rows.length)} row{cluster.rows.length === 1 ? "" : "s"} ·{" "}
                          {money(cluster.total)}
                          {cluster.first ? ` · ${dateLabel(cluster.first)} – ${dateLabel(cluster.last)}` : ""}
                        </>
                      }
                      action={
                        <button
                          type="button"
                          onClick={() => setPickerFor(pickerFor === cluster.description ? null : cluster.description)}
                          disabled={pending}
                          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                        >
                          {isSuggestion ? "Change…" : "Categorize as…"}
                        </button>
                      }
                    />

                    {pickerFor === cluster.description ? (
                      <PickerInline
                        products={products}
                        onPick={(p) => decide(cluster.description, ids, p)}
                        onCancel={() => setPickerFor(null)}
                      />
                    ) : null}

                    {isSuggestion ? (
                      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-warning-soft/40 px-5 py-2.5">
                        <span className="text-xs text-muted">
                          Currently filed under{" "}
                          <strong className="font-semibold text-ink">
                            {cluster.suggestion!.sectorName} → {cluster.suggestion!.name}
                          </strong>{" "}
                          at {(cluster.confidence * 100).toFixed(0)}% — but that product also covers
                          unrelated things, so it was sent here instead of being accepted.
                        </span>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => decide(cluster.description, ids, cluster.suggestion!)}
                          className="ml-auto rounded-md border border-line-strong px-2.5 py-1 text-[11px] font-semibold hover:bg-surface disabled:opacity-50"
                        >
                          Keep it
                        </button>
                      </div>
                    ) : null}

                    <CardBody className="pt-3">
                      <ul className="divide-y divide-line">
                        {cluster.rows.slice(0, 4).map((row) => (
                          <li key={row.id} className="flex items-center justify-between gap-3 py-1.5">
                            <span className="min-w-0 text-xs text-muted">
                              {dateLabel(row.occurred_at)}
                              {row.note ? ` · ${truncate(row.note, 50)}` : ""}
                              {row.account?.name ? ` · ${row.account.name}` : ""}
                            </span>
                            <span className="tnum shrink-0 text-xs font-medium text-ink">
                              {money(num(row.amount))}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {cluster.rows.length > 4 ? (
                        <p className="mt-2 text-[11px] text-faint">
                          + {count(cluster.rows.length - 4)} more like these
                        </p>
                      ) : null}
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function PickerInline({
  products,
  onPick,
  onCancel,
}: {
  products: ProductOption[];
  onPick: (product: ProductOption) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 25);
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.sectorName.toLowerCase().includes(q) ||
          p.sectorSlug.includes(q),
      )
      .slice(0, 25);
  }, [products, query]);

  return (
    <div className="border-b border-line bg-sunken/60 px-5 py-3">
      <div className="flex items-center gap-2">
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
          placeholder="Search products… (Enter picks the first)"
          className="field max-w-sm"
          aria-label="Search products"
        />
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {matches.length === 0 ? (
          <p className="py-2 text-xs text-muted">
            Nothing called “{query}”. Pick the closest sector — the categorizer creates the exact
            product later.
          </p>
        ) : (
          matches.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p)}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs transition-colors hover:border-accent hover:bg-accent-soft"
            >
              <SectorIcon icon={p.sectorIcon} />
              {p.name}
              <span className="text-[10px] text-faint">{p.sectorName}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
