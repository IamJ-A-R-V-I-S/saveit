import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import {
  CreateProductForm,
  MergePanel,
  SectorProductList,
} from "@/components/taxonomy/taxonomy-actions";
import { Badge, Card, CardBody, CardHeader, SectorIcon } from "@/components/ui";
import { getAliases, getMergeCandidates, getProducts } from "@/lib/data/taxonomy";
import { getSectors } from "@/lib/data/sectors";
import { count, percent } from "@/lib/format";

export const metadata: Metadata = { title: "Taxonomy" };

/**
 * The taxonomy.
 *
 * Sectors are fixed at 14 and read-only — that is what keeps a chart from
 * January comparable to one from June. Products underneath them are yours and
 * grow with your data: `Cha`, `Thumbs-up` and `Sugarcane juice` are real
 * products in the sample ledger, not "Beverages". A tree the vendor chose would
 * have filed all three somewhere useless.
 */
export default async function TaxonomyPage() {
  const [sectors, products, candidates, aliases] = await Promise.all([
    getSectors(),
    getProducts({ limit: 1000 }),
    getMergeCandidates(),
    getAliases(60),
  ]);

  const totalUses = products.reduce((n, p) => n + (p.use_count ?? 0), 0);
  const learned = aliases.filter((a) => a.source === "correction").length;

  return (
    <>
      <PageHeading
        title="Taxonomy"
        sub="Sectors are fixed so reporting stays comparable. Products are yours and grow as your statements mention them."
        action={<CreateProductForm sectors={sectors} />}
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="card px-4 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted uppercase">Products</p>
          <p className="tnum mt-1 text-xl font-semibold">{count(products.length)}</p>
          <p className="text-[11px] text-faint">across {count(sectors.length)} fixed sectors</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted uppercase">Transactions covered</p>
          <p className="tnum mt-1 text-xl font-semibold">{count(totalUses)}</p>
          <p className="text-[11px] text-faint">rows matched by a product</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-[11px] font-medium tracking-wide text-muted uppercase">Aliases learned</p>
          <p className="tnum mt-1 text-xl font-semibold">{count(learned)}</p>
          <p className="text-[11px] text-faint">from your corrections</p>
        </div>
      </div>

      <div className="mt-5">
        <MergePanel candidates={candidates} />
      </div>

      <div className="mt-5">
        <SectorProductList sectors={sectors} products={products} />
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Learned aliases"
          hint="Written when you correct a row. The next description matching one of these resolves deterministically — no model call, no review queue."
          action={<Badge tone="info">{count(aliases.length)}</Badge>}
        />
        <CardBody>
          {aliases.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              None yet. Correct a row in the{" "}
              <a href="/review" className="font-semibold text-accent hover:underline">
                review queue
              </a>{" "}
              and the pattern shows up here.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {aliases.map((alias) => (
                <li key={alias.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <code className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink">
                      {alias.pattern}
                    </code>
                    <span className="text-xs text-muted" aria-hidden>
                      →
                    </span>
                    <span className="truncate text-sm text-ink">
                      {alias.product?.name ?? "(removed product)"}
                    </span>
                    {alias.product?.sector?.name ? (
                      <span className="shrink-0 text-[11px] text-faint">
                        <SectorIcon icon={null} className="mr-1" />
                        {alias.product.sector.name}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[11px] text-faint">
                    <Badge>{alias.pattern_type}</Badge>
                    {alias.hit_count > 0 ? (
                      <span className="tnum">matched {count(alias.hit_count)}×</span>
                    ) : (
                      <span>not used yet</span>
                    )}
                    <span className="tnum">{percent(Number(alias.confidence) * 100)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
