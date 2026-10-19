import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import { ReviewQueue, type ReviewCluster } from "@/components/review/review-queue";
import { Card, CardBody } from "@/components/ui";
import { getPendingCount, getReviewQueue } from "@/lib/data/review";
import { getProducts } from "@/lib/data/taxonomy";
import type { ProductOption } from "@/components/transactions/ledger-table";
import { num } from "@/lib/format";
import type { Transaction } from "@/lib/types";

export const metadata: Metadata = { title: "Review queue" };

/**
 * Group review rows by description.
 *
 * The grouping is what makes the queue tractable. The sample statement has 785
 * rows described `Cha`; presented individually that is 785 decisions, presented
 * as one cluster it is one. `applyToSimilar` on the correction then fixes rows
 * that are not even in this batch.
 *
 * Normalization mirrors `canonicalizeName` in `_shared/taxonomy.ts` so that
 * `Cha`, `CHA ` and `cha.` collapse into one cluster — the same rule the
 * resolver uses to match them.
 */
function canonical(description: string | null): string {
  return (description ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function buildClusters(rows: Transaction[]): ReviewCluster[] {
  const groups = new Map<string, Transaction[]>();

  for (const row of rows) {
    const key = canonical(row.raw_description) || `__row_${row.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const clusters: ReviewCluster[] = [];

  for (const group of groups.values()) {
    // The display form is the most common spelling in the group, not the first
    // one seen, so a cluster labelled `Cha` isn't headed `cha.` by accident.
    const spellings = new Map<string, number>();
    for (const r of group) {
      const d = r.raw_description?.trim();
      if (d) spellings.set(d, (spellings.get(d) ?? 0) + 1);
    }
    const description =
      [...spellings.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      group[0].note ??
      "(no description)";

    const dates = group.map((r) => r.occurred_at).sort();
    // An exact match exists when the rows carry a product. Those are the
    // ambiguous-sector cases; rows with no product are genuine misses.
    const matched = group.find((r) => r.product?.id);

    clusters.push({
      description,
      rows: group,
      total: group.reduce((sum, r) => sum + num(r.amount), 0),
      first: dates[0] ?? null,
      last: dates[dates.length - 1] ?? null,
      confidence: matched ? num(matched.confidence) : 0,
      suggestion: matched?.product?.id
        ? {
            id: matched.product.id,
            name: matched.product.name,
            sectorSlug: matched.product.sector?.slug ?? "",
            sectorName: matched.product.sector?.name ?? "Uncategorized",
            sectorIcon: matched.product.sector?.icon ?? null,
            useCount: 0,
          }
        : null,
    });
  }

  // Most rows first: clearing the biggest cluster does the most good, and it is
  // usually the one the user recognizes immediately.
  return clusters.sort((a, b) => b.rows.length - a.rows.length);
}

export default async function ReviewPage() {
  const [rows, pendingCount, products] = await Promise.all([
    getReviewQueue(500),
    getPendingCount(),
    getProducts({ limit: 600 }),
  ]);

  const clusters = buildClusters(rows);
  const productOptions: ProductOption[] = products.map((p) => ({
    id: p.id,
    name: p.name,
    sectorSlug: p.sector?.slug ?? "",
    sectorName: p.sector?.name ?? "",
    sectorIcon: p.sector?.icon ?? null,
    useCount: p.use_count ?? 0,
  }));

  const ambiguous = clusters.filter((c) => c.suggestion).length;

  return (
    <>
      <PageHeading
        title="Review queue"
        sub="Rows the parser would have to guess at. Deciding one description decides every row like it, and teaches the resolver so it never asks again."
      />

      {clusters.length > 0 ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <MiniStat label="In the queue" value={clusters.length} note="distinct descriptions" />
          <MiniStat label="Rows affected" value={rows.length} note="transactions waiting" />
          <MiniStat
            label="Ambiguous matches"
            value={ambiguous}
            note="matched something too broad to trust"
          />
        </div>
      ) : null}

      <div className="mt-5">
        <ReviewQueue clusters={clusters} products={productOptions} pendingCount={pendingCount} />
      </div>

      <Card className="mt-6">
        <CardBody className="text-xs leading-relaxed text-muted">
          <p className="font-semibold text-ink">Why some rows are here even though they matched</p>
          <p className="mt-1.5">
            A confident match on a broad product is worse than no match at all, because it looks
            settled. <code className="font-mono text-[11px]">Charges, Fees</code> in the sample data
            covers exam fees, brokerage, a maid and a freelancer — so an exact hit on it is routed
            here rather than accepted. Once you split it, the resolver uses your products instead.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

function MiniStat({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className="tnum mt-1 text-xl font-semibold text-ink">{value}</p>
      <p className="text-[11px] text-faint">{note}</p>
    </div>
  );
}
