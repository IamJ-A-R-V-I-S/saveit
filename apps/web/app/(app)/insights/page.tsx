import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import { InsightList, type InsightWithEvidence } from "@/components/insights/insight-list";
import { getInsights, getLatestInsightWindow } from "@/lib/data/insights";
import { getTransactionsByIds } from "@/lib/data/transactions";
import type { Insight, Transaction } from "@/lib/types";

export const metadata: Metadata = { title: "Insights" };

/**
 * Pull the transaction ids out of an insight's `evidence` jsonb.
 *
 * Defensive about shape because the evidence is written by the coach function
 * and is an array of loosely-typed objects: entries may carry `id`, or only a
 * description and amount. Anything without an id is dropped here and reported by
 * the UI as "no linked transactions" rather than crashing the panel.
 */
function evidenceIds(insight: Insight): string[] {
  if (!Array.isArray(insight.evidence)) return [];
  const ids: string[] = [];
  for (const item of insight.evidence) {
    if (item && typeof item === "object") {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

export default async function InsightsPage() {
  const [insights, latest] = await Promise.all([getInsights({ limit: 25 }), getLatestInsightWindow()]);

  // One batched fetch for every insight's evidence, not one per insight. The
  // coach typically cites 5–15 rows per opportunity, so a page of 25 insights
  // would otherwise fire 25 queries.
  const allIds = [...new Set(insights.flatMap(evidenceIds))].slice(0, 400);
  const fetched = allIds.length > 0 ? await getTransactionsByIds(allIds) : [];
  const byId = new Map<string, Transaction>(fetched.map((t) => [t.id, t]));

  const items: InsightWithEvidence[] = insights.map((insight) => ({
    insight,
    // Preserve the coach's own ordering of the evidence; it usually puts the
    // most representative rows first.
    evidence: evidenceIds(insight)
      .map((id) => byId.get(id))
      .filter((t): t is Transaction => Boolean(t)),
  }));

  return (
    <>
      <PageHeading
        title="Coach"
        sub="Ranked by what it would save you per month. Every claim can be expanded to the transactions behind it — a savings estimate you can't check is just an opinion."
      />
      <div className="mt-6">
        <InsightList items={items} range={{ start: latest.start, end: latest.end }} />
      </div>
    </>
  );
}
