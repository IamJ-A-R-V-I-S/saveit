import Link from "next/link";
import type { Metadata } from "next";
import { MonthTrend, RankedBars, type TrendPoint } from "@/components/charts";
import { Badge, Card, CardBody, CardHeader, EmptyState, Money, ProgressBar, Stat, cx } from "@/components/ui";
import { PageHeading } from "@/components/page-heading";
import { getBudgets, budgetsAtRisk } from "@/lib/data/budgets";
import {
  getDashboardSummary,
  getMonthlyCoverage,
  getMonthlySectorSpend,
  getTopProducts,
  latestMonth,
} from "@/lib/data/dashboard";
import { getInsights, totalMonthlyOpportunity } from "@/lib/data/insights";
import { getReviewClusters, getReviewQueue } from "@/lib/data/review";
import { count, dateLabel, money, monthLabel, num, relativeTime } from "@/lib/format";
import type { MonthlyCoverage } from "@/lib/types";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * How thin a month has to be before it is labelled sparse rather than cheap.
 *
 * Derived from the user's own data (median transaction count) rather than a
 * fixed number, because "sparse" means different things for someone who pays
 * for everything by UPI and someone who mostly uses cash. The sample statement
 * ranges from 14 transactions in a month to 267, so a constant would either
 * flag nothing or flag everything.
 */
function sparseThreshold(coverage: MonthlyCoverage[]): number {
  if (coverage.length < 3) return 0;
  const counts = coverage.map((c) => c.tx_count).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  return Math.max(10, Math.round(median * 0.3));
}

export default async function DashboardPage() {
  const [summary, coverage, sectorSpendAll, topInsights, reviewRows, clusters, budgets] =
    await Promise.all([
      getDashboardSummary(),
      getMonthlyCoverage(12),
      getMonthlySectorSpend(12),
      getInsights({ limit: 3 }),
      getReviewQueue(6),
      getReviewClusters(5),
      getBudgets(),
    ]);

  const month = latestMonth(coverage);
  const threshold = sparseThreshold(coverage);

  const topProducts = month ? await getTopProducts(month, 8) : [];

  const trend: TrendPoint[] = coverage.map((c) => ({
    month: c.month,
    spend: num(c.total_spend),
    income: num(c.total_income),
    txCount: c.tx_count,
    sparse: threshold > 0 && c.tx_count < threshold,
  }));

  const currentMonth = coverage.find((c) => c.month === month) ?? null;
  const previous = coverage.length > 1 ? coverage[coverage.length - 2] : null;

  // Computed here, not stored on the row: `v_monthly_coverage` reports counts,
  // and "sparse" is a judgement about those counts relative to this user's own
  // median. Keeping it out of the view means the threshold can change without a
  // migration.
  const currentIsSparse =
    threshold > 0 && currentMonth !== null && currentMonth.tx_count < threshold;

  const sectorsThisMonth = sectorSpendAll
    .filter((s) => s.month === month)
    .sort((a, b) => num(b.spend) - num(a.spend));

  const atRisk = budgetsAtRisk(budgets);
  const opportunity = totalMonthlyOpportunity(topInsights);

  /* ------------------------------------------------------- empty ledger ---- */

  if (!summary || summary.total_transactions === 0) {
    return (
      <>
        <PageHeading
          title="Your ledger is empty"
          sub="Upload a statement and SaveIt does the categorizing."
        />
        <Card className="mt-6">
          <EmptyState
            icon={<span className="text-4xl">⇪</span>}
            title="Upload your first statement"
            body={
              <>
                CSV, XLSX, PDF or a photo of a paper statement. A tracker export works best to
                start with — on the statement this was built against,{" "}
                <strong className="font-semibold text-ink">99.98% of 5,535 rows</strong> were
                categorized without a single model call.
              </>
            }
            action={
              <Link
                href="/upload"
                className="inline-block rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
              >
                Upload a statement
              </Link>
            }
          />
        </Card>

        <Card className="mt-4">
          <CardHeader title="Or type it in" hint="Statements miss things — cash, split bills, a subscription paid from an account you never export." />
          <CardBody>
            <Link href="/transactions?add=1" className="text-sm font-semibold text-accent hover:underline">
              Add a transaction manually →
            </Link>
          </CardBody>
        </Card>
      </>
    );
  }

  /* ------------------------------------------------------------ headline --- */

  const spendNow = currentMonth ? num(currentMonth.total_spend) : 0;
  const incomeNow = currentMonth ? num(currentMonth.total_income) : 0;
  const spendPrev = previous ? num(previous.total_spend) : null;

  const delta = spendPrev && spendPrev > 0 ? ((spendNow - spendPrev) / spendPrev) * 100 : null;

  return (
    <>
      <PageHeading
        title={month ? monthLabel(month) : "Dashboard"}
        sub={
          currentIsSparse
            ? "This month looks thin — you may not have uploaded all of it yet."
            : summary.last_transaction
              ? `Data through ${dateLabel(summary.last_transaction)} · ${count(summary.total_transactions)} transactions total`
              : undefined
        }
        action={
          <Link
            href="/upload"
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
          >
            ⇪ Upload
          </Link>
        }
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Spend this month"
          value={money(spendNow)}
          tone="spend"
          sub={
            delta === null ? (
              "No previous month to compare"
            ) : (
              <span className={cx("font-medium", delta > 0 ? "text-danger" : "text-success")}>
                {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(0)}% vs {previous ? monthLabel(previous.month) : ""}
              </span>
            )
          }
        />
        <Stat
          label="Income this month"
          value={money(incomeNow)}
          tone="income"
          sub={
            incomeNow - spendNow >= 0 ? (
              <span className="text-success">
                Surplus {money(incomeNow - spendNow)}
              </span>
            ) : (
              <span className="text-danger">
                Short by {money(spendNow - incomeNow)}
              </span>
            )
          }
        />
        <Stat
          label="Needs your review"
          value={count(summary.needs_review)}
          tone={summary.needs_review > 0 ? "warning" : "success"}
          href="/review"
          sub={summary.needs_review > 0 ? "Ambiguous or unrecognized" : "Queue is clear"}
        />
        <Stat
          label="Coach can save"
          value={opportunity > 0 ? `${money(opportunity)}/mo` : "—"}
          tone="info"
          href="/insights"
          sub={
            topInsights.length > 0
              ? `${count(topInsights.length)} open ${topInsights.length === 1 ? "opportunity" : "opportunities"}`
              : "Run the coach to find out"
          }
        />
      </div>

      {atRisk.length > 0 ? (
        <Card className="mt-4 border-warning/30">
          <CardBody className="py-3.5">
            <p className="text-sm">
              <span className="font-semibold text-warning">⚠ {atRisk.length} budget{atRisk.length === 1 ? "" : "s"} at risk.</span>{" "}
              <span className="text-muted">
                {atRisk
                  .slice(0, 3)
                  .map((b) => `${b.sector_name} at ${Number(b.pct_used).toFixed(0)}%`)
                  .join(", ")}
                {atRisk.length > 3 ? `, and ${atRisk.length - 3} more` : ""}.
              </span>{" "}
              <Link href="/budgets" className="font-semibold text-accent hover:underline">
                Review →
              </Link>
            </p>
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------------------------------------- main grid ---- */}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Spend and income by month"
            hint="Hatched bars are months where the data looks incomplete, not months where you spent less."
          />
          <CardBody>
            <MonthTrend points={trend} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={month ? `Where it went in ${monthLabel(month)}` : "Where it went"}
            action={
              <Link href="/transactions" className="text-xs font-semibold text-accent hover:underline">
                All
              </Link>
            }
          />
          <CardBody>
            <RankedBars
              rows={sectorsThisMonth.slice(0, 8).map((s) => ({
                id: s.sector_id,
                label: s.sector_name,
                icon: s.sector_icon,
                value: num(s.spend),
                meta: `${count(s.tx_count)}×`,
                href: `/transactions?sector=${s.sector_slug}${month ? `&month=${month}` : ""}`,
              }))}
              emptyLabel="No spend recorded this month"
            />
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* -------------------------------------------- top products ---- */}
        <Card>
          <CardHeader
            title="Top products"
            hint="The actionable level — a sector is a description, a product is something you can change."
            action={
              <Link href="/taxonomy" className="text-xs font-semibold text-accent hover:underline">
                Taxonomy
              </Link>
            }
          />
          <CardBody>
            <RankedBars
              tone="accent"
              rows={topProducts.map((p) => ({
                id: p.product_id,
                label: p.product_name,
                value: num(p.spend),
                meta: `${count(p.tx_count)}× · avg ${money(num(p.avg_ticket))}`,
                href: `/transactions?product=${p.product_id}`,
              }))}
              emptyLabel="Nothing categorized this month yet"
            />
          </CardBody>
        </Card>

        {/* -------------------------------------------------- insights ---- */}
        <Card>
          <CardHeader
            title="Coach"
            hint="Ranked by what it would save you per month."
            action={
              <Link href="/insights" className="text-xs font-semibold text-accent hover:underline">
                All insights
              </Link>
            }
          />
          <CardBody>
            {topInsights.length === 0 ? (
              <EmptyState
                icon={<span className="text-3xl">◎</span>}
                title="No insights yet"
                body={
                  <>
                    The coach looks for patterns across at least three months. Once you have data,
                    run it from the{" "}
                    <Link href="/insights" className="font-semibold text-accent hover:underline">
                      insights page
                    </Link>
                    .
                  </>
                }
              />
            ) : (
              <ol className="space-y-3">
                {topInsights.map((insight, i) => (
                  <li key={insight.id} className="flex gap-3">
                    <span className="tnum mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-bold text-muted">
                      {insight.rank ?? i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug font-medium text-ink">{insight.headline}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        {num(insight.monthly_saving_estimate) > 0 ? (
                          <Badge tone="success">
                            saves {money(insight.monthly_saving_estimate)}/mo
                          </Badge>
                        ) : null}
                        {insight.sector?.name ? <Badge>{insight.sector.name}</Badge> : null}
                        <span className="text-[11px] text-faint">
                          {relativeTime(insight.created_at)}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      {/* -------------------------------------------------- review + docs ---- */}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Waiting on you"
            hint="Rows the parser couldn't place confidently. Fixing one description fixes every row like it."
            action={
              <Link href="/review" className="text-xs font-semibold text-accent hover:underline">
                Open queue
              </Link>
            }
          />
          <CardBody>
            {reviewRows.length === 0 && clusters.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">
                Nothing needs review. Every row is categorized.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {(clusters.length > 0 ? clusters : reviewRows).slice(0, 5).map((row) => {
                  const isCluster = "description_norm" in row;
                  const label = isCluster
                    ? row.description_norm
                    : (row.raw_description ?? row.note ?? "—");
                  const times = isCluster ? row.occurrences : null;
                  const amount = isCluster ? num(row.total_spend) : num(row.amount);

                  return (
                    <li key={isCluster ? `c-${row.description_norm}` : row.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink">{label}</p>
                        <p className="mt-0.5 text-[11px] text-faint">
                          {times ? `${count(times)} rows like this · ` : ""}
                          {isCluster
                            ? `${dateLabel(row.first_seen)} – ${dateLabel(row.last_seen)}`
                            : dateLabel(row.occurred_at)}
                        </p>
                      </div>
                      <span className="tnum shrink-0 text-sm font-medium text-muted">
                        {money(amount)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Categorization coverage"
            hint="How much of the ledger the deterministic resolver placed without a model call."
            action={
              <Link href="/documents" className="text-xs font-semibold text-accent hover:underline">
                Documents
              </Link>
            }
          />
          <CardBody>
            {coverage.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No monthly data yet.</p>
            ) : (
              <ul className="space-y-3">
                {coverage
                  .slice(-5)
                  .reverse()
                  .map((c) => (
                    <li key={c.month}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-ink">{monthLabel(c.month)}</span>
                        <span className="tnum text-xs text-muted">
                          {count(c.tx_count)} rows · {Number(c.categorize_pct).toFixed(1)}% categorized
                        </span>
                      </div>
                      <ProgressBar
                        className="mt-1.5"
                        pct={num(c.categorize_pct)}
                        tone={
                          num(c.categorize_pct) >= 95
                            ? "success"
                            : num(c.categorize_pct) >= 80
                              ? "warning"
                              : "danger"
                        }
                      />
                      {c.uncategorized > 0 || c.needs_review > 0 ? (
                        <p className="mt-1 text-[11px] text-faint">
                          {c.uncategorized > 0 ? `${count(c.uncategorized)} uncategorized` : ""}
                          {c.uncategorized > 0 && c.needs_review > 0 ? " · " : ""}
                          {c.needs_review > 0 ? `${count(c.needs_review)} in review` : ""}
                        </p>
                      ) : null}
                    </li>
                  ))}
              </ul>
            )}

            <dl className="mt-5 space-y-1 border-t border-line pt-3">
              <div className="flex justify-between py-0.5">
                <dt className="text-xs text-muted">All-time spend</dt>
                <dd className="tnum text-xs font-medium">
                  <Money amount={summary.total_spend} />
                </dd>
              </div>
              <div className="flex justify-between py-0.5">
                <dt className="text-xs text-muted">All-time income</dt>
                <dd className="tnum text-xs font-medium">
                  <Money amount={summary.total_income} direction="credit" />
                </dd>
              </div>
              <div className="flex justify-between py-0.5">
                <dt className="text-xs text-muted">Products in your taxonomy</dt>
                <dd className="tnum text-xs font-medium">{count(summary.product_count)}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
