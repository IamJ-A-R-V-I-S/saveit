"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { runCoach, updateInsightStatus } from "@/lib/actions/insights";
import { Badge, Card, CardBody, CardHeader, Money, ProgressBar, SectorIcon, cx } from "@/components/ui";
import { count, dateLabel, dateTimeLabel, money, moneyExact, num, percent } from "@/lib/format";
import type { Insight, Transaction } from "@/lib/types";

/**
 * Coach output.
 *
 * The coach was specified to return ranked savings opportunities with rupee
 * estimates AND the exact transactions behind them. The evidence disclosure is
 * not a nicety — it is what makes a claim like "you could save ₹1,800 a month"
 * checkable instead of something you have to take on faith. A savings app that
 * cannot show its working is just an opinion.
 */

export interface InsightWithEvidence {
  insight: Insight;
  evidence: Transaction[];
}

type Feedback = { tone: "ok" | "err" | "info"; text: string } | null;

export function InsightList({
  items,
  range,
}: {
  items: InsightWithEvidence[];
  /** The period the last coach run covered. Not called `window` — that would
   *  shadow the browser global inside a client component. */
  range: { start: string | null; end: string | null };
}) {
  const [months, setMonths] = useState(3);
  const [push, setPush] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Map<string, string>>(new Map());
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  const visible = items.filter((i) => statuses.get(i.insight.id) !== "dismissed");
  const total = visible
    .filter((i) => i.insight.kind === "opportunity")
    .reduce((sum, i) => sum + num(i.insight.monthly_saving_estimate), 0);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setStatus(id: string, status: "accepted" | "dismissed" | "acted_on") {
    setStatuses((prev) => new Map(prev).set(id, status));
    startTransition(async () => {
      const result = await updateInsightStatus(id, status);
      if (!result.ok) {
        // Revert: an optimistic status that failed to persist would silently
        // come back on the next visit and look like the app ignored the click.
        setStatuses((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        setFeedback({ tone: "err", text: result.error });
      }
    });
  }

  function generate() {
    setFeedback(null);
    startTransition(async () => {
      const result = await runCoach({ months, push });
      if (!result.ok) {
        setFeedback({ tone: result.notDeployed ? "info" : "err", text: result.error });
        return;
      }
      const found = result.result.insights ?? result.result.opportunities?.length ?? 0;
      setFeedback({
        tone: "ok",
        text:
          found > 0
            ? `Found ${count(found)} opportunit${found === 1 ? "y" : "ies"} across ${months} month${months === 1 ? "" : "s"}.`
            : `Looked at ${months} month${months === 1 ? "" : "s"} and found nothing worth changing. That is a result, not a failure.`,
      });
    });
  }

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------- run the coach ---- */}
      <Card>
        <CardHeader
          title="Ask the coach"
          hint={
            range.start
              ? `Last run covered ${dateLabel(range.start)} – ${dateLabel(range.end ?? undefined)}.`
              : "It has not run yet. It needs at least three months of transactions to find a pattern worth acting on."
          }
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-4">
            <label>
              <span className="label">Look back</span>
              <div className="flex gap-1">
                {[3, 6, 12].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMonths(m)}
                    className={cx(
                      "rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
                      months === m
                        ? "border-accent bg-accent-soft text-ink"
                        : "border-line-strong text-muted hover:bg-sunken",
                    )}
                  >
                    {m} mo
                  </button>
                ))}
              </div>
            </label>

            <label className="flex items-center gap-2 pb-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={push}
                onChange={(e) => setPush(e.target.checked)}
                className="size-3.5 accent-[var(--accent)]"
              />
              Also push to Telegram
            </label>

            <button
              type="button"
              onClick={generate}
              disabled={pending}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Analyzing…" : "Run the coach"}
            </button>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            A longer window finds slower trends but makes recent changes look smaller than they are.
            Three months is the default for that reason.
          </p>
        </CardBody>
      </Card>

      {feedback ? (
        <p
          role="status"
          className={cx(
            "rounded-lg border px-3 py-2.5 text-xs leading-relaxed whitespace-pre-line",
            feedback.tone === "ok"
              ? "border-success/25 bg-success-soft text-success"
              : feedback.tone === "info"
                ? "border-info/25 bg-info-soft text-info"
                : "border-danger/25 bg-danger-soft text-danger",
          )}
        >
          {feedback.text}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <Card>
          <CardBody className="py-14 text-center">
            <p className="text-3xl" aria-hidden>
              ◎
            </p>
            <p className="mt-3 text-sm font-semibold text-ink">No insights yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted">
              Run the coach above once you have a few months of transactions. It ranks what it finds
              by what it would save you per month, and shows the transactions behind each claim.
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">
              {count(visible.length)} opportunit{visible.length === 1 ? "y" : "ies"}
            </h2>
            {total > 0 ? (
              <p className="text-sm text-muted">
                Worth up to{" "}
                <strong className="tnum font-semibold text-success">{money(total)}</strong> a month
              </p>
            ) : null}
          </div>

          <ol className="space-y-3">
            {visible.map(({ insight, evidence }, index) => {
              const status = statuses.get(insight.id) ?? insight.status;
              const saving = num(insight.monthly_saving_estimate);
              const isOpen = expanded.has(insight.id);

              return (
                <li key={insight.id}>
                  <Card
                    className={cx(
                      status === "accepted" && "border-success/40",
                      status === "acted_on" && "border-accent/40",
                    )}
                  >
                    <CardHeader
                      title={
                        <span className="flex items-start gap-2.5">
                          <span className="tnum mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-bold text-muted">
                            {insight.rank ?? index + 1}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm leading-snug font-semibold text-ink text-balance">
                              {insight.headline}
                            </span>
                          </span>
                        </span>
                      }
                      action={
                        saving > 0 ? (
                          <span className="tnum text-right">
                            <span className="block text-base font-semibold text-success">
                              {money(saving)}
                            </span>
                            <span className="block text-[10px] tracking-wide text-faint uppercase">
                              per month
                            </span>
                          </span>
                        ) : null
                      }
                    />

                    <CardBody className="space-y-3">
                      {insight.detail ? (
                        <p className="text-sm leading-relaxed text-muted">{insight.detail}</p>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-1.5">
                        {insight.sector?.name ? (
                          <Badge>
                            <SectorIcon icon={insight.sector.icon} />
                            {insight.sector.name}
                          </Badge>
                        ) : null}
                        {insight.product?.name ? <Badge tone="info">{insight.product.name}</Badge> : null}
                        {num(insight.confidence) > 0 ? (
                          <Badge
                            tone={num(insight.confidence) >= 0.7 ? "success" : "warning"}
                            title={`model confidence ${num(insight.confidence).toFixed(2)}`}
                          >
                            {percent(num(insight.confidence) * 100)} confident
                          </Badge>
                        ) : null}
                        {status === "accepted" ? <Badge tone="success">accepted</Badge> : null}
                        {status === "acted_on" ? <Badge tone="info">acted on</Badge> : null}
                        <span className="text-[11px] text-faint">
                          {insight.llm_model ? `${insight.llm_model} · ` : ""}
                          {dateTimeLabel(insight.created_at)}
                        </span>
                      </div>

                      {evidence.length > 0 ? (
                        <>
                          <button
                            type="button"
                            onClick={() => toggle(insight.id)}
                            aria-expanded={isOpen}
                            className="flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
                          >
                            <span aria-hidden className={cx("transition-transform", isOpen && "rotate-90")}>
                              ▸
                            </span>
                            {isOpen ? "Hide" : "Show"} the {count(evidence.length)} transaction
                            {evidence.length === 1 ? "" : "s"} behind this
                          </button>

                          {isOpen ? (
                            <div className="overflow-hidden rounded-lg border border-line">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-line bg-sunken">
                                    <th className="px-3 py-1.5 text-left font-semibold text-muted">Date</th>
                                    <th className="px-3 py-1.5 text-left font-semibold text-muted">Description</th>
                                    <th className="px-3 py-1.5 text-right font-semibold text-muted">Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {evidence.map((tx) => (
                                    <tr key={tx.id} className="border-b border-line last:border-0">
                                      <td className="tnum px-3 py-1.5 whitespace-nowrap text-muted">
                                        {dateLabel(tx.occurred_at)}
                                      </td>
                                      <td className="max-w-60 truncate px-3 py-1.5 text-ink">
                                        {tx.raw_description ?? "—"}
                                      </td>
                                      <td className="tnum px-3 py-1.5 text-right whitespace-nowrap">
                                        <Money amount={tx.amount} direction={tx.direction} exact />
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr className="bg-sunken">
                                    <td className="px-3 py-1.5 font-semibold text-muted" colSpan={2}>
                                      Total shown
                                    </td>
                                    <td className="tnum px-3 py-1.5 text-right font-semibold text-ink">
                                      {moneyExact(
                                        evidence.reduce((s, t) => s + num(t.amount), 0),
                                      )}
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <p className="text-[11px] text-faint">
                          No linked transactions — this came from an aggregate pattern rather than
                          individual rows.
                        </p>
                      )}

                      {saving > 0 ? (
                        <div>
                          <div className="flex items-baseline justify-between text-[11px] text-muted">
                            <span>If you cut this entirely</span>
                            <span className="tnum font-semibold text-success">
                              {money(saving * 12)} a year
                            </span>
                          </div>
                          <ProgressBar className="mt-1" pct={100} tone="success" />
                        </div>
                      ) : null}

                      <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
                        {status !== "accepted" && status !== "acted_on" ? (
                          <button
                            type="button"
                            onClick={() => setStatus(insight.id, "accepted")}
                            disabled={pending}
                            className="rounded-md bg-success-soft px-2.5 py-1 text-[11px] font-semibold text-success hover:opacity-80 disabled:opacity-50"
                          >
                            Worth doing
                          </button>
                        ) : null}
                        {status === "accepted" ? (
                          <button
                            type="button"
                            onClick={() => setStatus(insight.id, "acted_on")}
                            disabled={pending}
                            className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                          >
                            I did this
                          </button>
                        ) : null}
                        {status !== "dismissed" ? (
                          <button
                            type="button"
                            onClick={() => setStatus(insight.id, "dismissed")}
                            disabled={pending}
                            className="rounded-md border border-line-strong px-2.5 py-1 text-[11px] font-semibold text-muted hover:bg-sunken disabled:opacity-50"
                          >
                            Not for me
                          </button>
                        ) : null}
                        {insight.product?.name ? (
                          <Link
                            href="/transactions"
                            className="ml-auto rounded-md px-2.5 py-1 text-[11px] font-medium text-faint hover:text-accent"
                          >
                            Browse the ledger →
                          </Link>
                        ) : null}
                      </div>
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
