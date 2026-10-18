import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeading } from "@/components/page-heading";
import { FilterBar } from "@/components/transactions/filter-bar";
import { LedgerTable, type ProductOption } from "@/components/transactions/ledger-table";
import { AddTransactionForm } from "@/components/transactions/add-form";
import { Card, CardBody } from "@/components/ui";
import { getMonthlyCoverage } from "@/lib/data/dashboard";
import { getSectors } from "@/lib/data/sectors";
import { getProducts } from "@/lib/data/taxonomy";
import { getAccounts, getTransactions } from "@/lib/data/transactions";
import { count, money, monthLabel } from "@/lib/format";
import type { CategorizeStatus, Direction } from "@/lib/types";

export const metadata: Metadata = { title: "Transactions" };

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** First of a value, when a param is repeated. Never an array — PostgREST wants one. */
function one(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function TransactionsPage({ searchParams }: Props) {
  const params = await searchParams;

  const filter = {
    month: one(params.month),
    sectorSlug: one(params.sector),
    accountId: one(params.account),
    productId: one(params.product),
    status: one(params.status) as CategorizeStatus | null,
    direction: one(params.dir) as Direction | null,
    search: one(params.q),
    sort: (one(params.sort) as never) ?? "date_desc",
    page: Math.max(1, Number(one(params.page) ?? "1") || 1),
    pageSize: 50,
  };

  const [page, sectors, accounts, products, coverage] = await Promise.all([
    getTransactions(filter),
    getSectors(),
    getAccounts(),
    getProducts({ limit: 600 }),
    getMonthlyCoverage(24),
  ]);

  const productOptions: ProductOption[] = products.map((p) => ({
    id: p.id,
    name: p.name,
    sectorSlug: p.sector?.slug ?? "",
    sectorName: p.sector?.name ?? "",
    sectorIcon: p.sector?.icon ?? null,
    useCount: p.use_count ?? 0,
  }));

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));

  const queryString = (next: Record<string, string | number | null>) => {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value) sp.set(key, value);
    }
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") sp.delete(key);
      else sp.set(key, String(value));
    }
    const s = sp.toString();
    return s ? `?${s}` : "?";
  };

  return (
    <>
      <PageHeading
        title="Transactions"
        sub={
          page.total > 0 ? (
            <>
              {count(page.filteredCount)} spend row{page.filteredCount === 1 ? "" : "s"} matching ·{" "}
              <strong className="font-semibold text-ink">{money(page.filteredSpend)}</strong>
              {page.totalsTruncated ? " (first 10,000 only)" : ""}
            </>
          ) : (
            "Nothing here yet."
          )
        }
      />

      <div className="mt-5 space-y-4">
        <Suspense fallback={null}>
          <FilterBar
            options={{
              months: coverage
                .map((c) => c.month)
                .reverse()
                .map((m) => ({ value: m, label: monthLabel(m) })),
              sectors: sectors.map((s) => ({ slug: s.slug, name: s.name, icon: s.icon })),
              accounts,
            }}
          />
        </Suspense>

        <AddTransactionForm products={productOptions} accounts={accounts} />

        {page.warning ? (
          <p className="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-xs text-warning">
            Could not load transactions: {page.warning}
          </p>
        ) : null}

        <LedgerTable
          rows={page.rows}
          products={productOptions}
          emptyMessage={
            page.total === 0
              ? "No transactions yet. Upload a statement or add one manually above."
              : "No transactions match these filters."
          }
        />

        {totalPages > 1 ? (
          <nav className="flex items-center justify-between gap-3" aria-label="Pagination">
            <span className="tnum text-xs text-muted">
              Page {count(page.page)} of {count(totalPages)} · {count(page.total)} rows
            </span>
            <div className="flex items-center gap-1.5">
              {page.page > 1 ? (
                <Link
                  href={queryString({ page: page.page - 1 })}
                  className="rounded-lg border border-line-strong px-3 py-1.5 text-xs font-semibold hover:bg-surface"
                >
                  ← Previous
                </Link>
              ) : null}
              {page.page < totalPages ? (
                <Link
                  href={queryString({ page: page.page + 1 })}
                  className="rounded-lg border border-line-strong px-3 py-1.5 text-xs font-semibold hover:bg-surface"
                >
                  Next →
                </Link>
              ) : null}
            </div>
          </nav>
        ) : null}
      </div>

      {filter.productId ? (
        <Card className="mt-4">
          <CardBody className="py-3 text-xs text-muted">
            Filtered to one product.{" "}
            <Link href={queryString({ product: null })} className="font-semibold text-accent hover:underline">
              Clear it
            </Link>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
