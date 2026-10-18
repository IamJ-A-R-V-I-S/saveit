import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { CategorizeStatus, Direction, Transaction } from "@/lib/types";

export interface TransactionFilter {
  /** `YYYY-MM-DD`, first of month. Bounds the range instead of truncating. */
  month?: string | null;
  sectorSlug?: string | null;
  accountId?: string | null;
  productId?: string | null;
  direction?: Direction | null;
  status?: CategorizeStatus | null;
  /** Matched against raw_description, note and payee. */
  search?: string | null;
  sort?: "date_desc" | "date_asc" | "amount_desc" | "amount_asc";
  page?: number;
  pageSize?: number;
}

export interface TransactionPage {
  rows: Transaction[];
  total: number;
  page: number;
  pageSize: number;
  /** Spend across ALL rows matching the filter, not just the visible page. */
  filteredSpend: number;
  filteredCount: number;
  /** True when the 10k cap on the totals query was reached. */
  totalsTruncated: boolean;
  warning?: string;
}

const SELECT = `
  *,
  account:accounts!transactions_account_id_fkey ( name, kind ),
  product:products!transactions_product_id_fkey (
    id, name,
    sector:sectors ( slug, name, icon )
  )
`;

/** The subset of the PostgREST builder the filters need. */
type Filterable = {
  gte(column: string, value: string): Filterable;
  lt(column: string, value: string): Filterable;
  eq(column: string, value: unknown): Filterable;
  in(column: string, values: unknown[]): Filterable;
  or(filter: string): Filterable;
};

/**
 * Apply the filters to a builder and return the SAME builder type.
 *
 * Two things here are load-bearing and both were bugs in the first draft:
 *
 * 1. It is SYNCHRONOUS. A PostgREST builder is a `PromiseLike`, so
 *    `await applyFilters(…)` unwraps twice — the outer Promise AND the thenable
 *    builder — and hands back the resolved response instead of the builder.
 *    `.order()` then does not exist on it. Anything that needs awaiting (the
 *    sector lookup) is resolved by the caller and passed in.
 *
 * 2. `Q` has no constraint. `Q extends Filterable` made the compiler instantiate
 *    the full builder type (TS2589) and infer `Q` as the response. Unconstrained
 *    inference is exact, so the casts route through `unknown`.
 */
function applyFilters<Q>(query: Q, filter: TransactionFilter, sectorProductIds: string[] | null): Q {
  let q = query as unknown as Filterable;

  if (filter.month) {
    const start = `${filter.month.slice(0, 7)}-01`;
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCMonth(end.getUTCMonth() + 1);
    q = q.gte("occurred_at", start).lt("occurred_at", end.toISOString().slice(0, 10));
  }
  if (filter.accountId) q = q.eq("account_id", filter.accountId);
  if (filter.direction) q = q.eq("direction", filter.direction);
  if (filter.status) q = q.eq("categorize_status", filter.status);

  if (filter.productId) {
    q = q.eq("product_id", filter.productId);
  } else if (filter.sectorSlug && sectorProductIds) {
    /*
     * Sector filtering resolves to product ids rather than being expressed as a
     * nested PostgREST filter. Filtering through two levels of embedded
     * resource (`product.sector.slug`) needs `!inner` on both joins to actually
     * exclude rows, and returns everything unfiltered otherwise — a failure mode
     * that looks like correct data.
     */
    if (sectorProductIds.length === 0) {
      // Nothing in this sector can match. `in` on an empty array is a no-op in
      // PostgREST, which would wrongly return every transaction.
      q = q.eq("product_id", "00000000-0000-0000-0000-000000000000");
    } else {
      q = q.in("product_id", sectorProductIds);
    }
  }

  if (filter.search?.trim()) {
    // PostgREST `.or()` parses commas and parentheses, so strip them rather
    // than let a search for "tea, sugar" become two malformed conditions.
    const term = filter.search.trim().replace(/[%,()]/g, " ").slice(0, 60);
    if (term) {
      q = q.or(
        `raw_description.ilike.%${term}%,note.ilike.%${term}%,payee.ilike.%${term}%`,
      );
    }
  }

  return q as unknown as Q;
}

async function productIdsInSector(sectorSlug: string): Promise<string[]> {
  const supabase = await createClient();
  const { data: sector } = await supabase
    .from("sectors")
    .select("id")
    .eq("slug", sectorSlug)
    .maybeSingle();
  if (!sector) return [];

  const { data: products, error } = await supabase
    .from("products")
    .select("id")
    .eq("sector_id", sector.id)
    .eq("status", "active")
    .limit(5000);

  if (error) {
    console.error("productIdsInSector:", error.message);
    return [];
  }
  return ((products as { id: string }[]) ?? []).map((p) => p.id);
}

/** Awaited once per request, then handed to both queries. */
async function resolveSectorIds(filter: TransactionFilter): Promise<string[] | null> {
  if (filter.productId || !filter.sectorSlug) return null;
  return productIdsInSector(filter.sectorSlug);
}

function sortSpec(sort: TransactionFilter["sort"]) {
  switch (sort) {
    case "amount_desc":
      return { column: "amount", ascending: false };
    case "amount_asc":
      return { column: "amount", ascending: true };
    case "date_asc":
      return { column: "occurred_at", ascending: true };
    default:
      return { column: "occurred_at", ascending: false };
  }
}

/**
 * The ledger, filtered and paginated.
 *
 * Pagination is server-side because the sample statement holds 5,535 rows;
 * pulling all of them into a Server Component on every navigation would be slow
 * and pointless.
 */
export async function getTransactions(
  filter: TransactionFilter = {},
): Promise<TransactionPage> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, filter.pageSize ?? 50));
  const from = (page - 1) * pageSize;

  const supabase = await createClient();
  const { column, ascending } = sortSpec(filter.sort);
  const sectorIds = await resolveSectorIds(filter);

  const query = applyFilters(
    supabase.from("transactions").select(SELECT, { count: "exact" }),
    filter,
    sectorIds,
  );

  const { data, error, count } = await query
    .order(column, { ascending })
    .range(from, from + pageSize - 1);

  const totals = await getFilterTotals(filter, sectorIds);

  if (error) {
    console.error("getTransactions:", error.message);
    return {
      rows: [],
      total: 0,
      page,
      pageSize,
      filteredSpend: 0,
      filteredCount: 0,
      totalsTruncated: false,
      warning: error.message,
    };
  }

  return {
    rows: (data as Transaction[]) ?? [],
    total: count ?? 0,
    page,
    pageSize,
    ...totals,
  };
}

const TOTALS_CAP = 10_000;

/**
 * Spend and count for the filter, ignoring pagination.
 *
 * A separate query rather than a reduce over the visible page: 50 rows are on
 * screen but "₹18,294 across 267 transactions" is the number worth showing
 * above the table. Capped at 10k rows; past that the UI says the total is
 * approximate rather than quietly showing a wrong figure.
 */
async function getFilterTotals(
  filter: TransactionFilter,
  sectorProductIds: string[] | null,
): Promise<{ filteredSpend: number; filteredCount: number; totalsTruncated: boolean }> {
  const supabase = await createClient();

  const query = applyFilters(
    supabase.from("transactions").select("amount"),
    // The direction is forced to debit below, so any caller-supplied direction
    // is overridden deliberately: the headline number is spend.
    { ...filter, direction: "debit" },
    sectorProductIds,
  );

  // `direction` is forced to debit in the filter above, so the headline number
  // is always spend. Applying `.eq` again here would duplicate the query param.
  const { data, error } = await query.limit(TOTALS_CAP);

  if (error || !data) {
    return { filteredSpend: 0, filteredCount: 0, totalsTruncated: false };
  }

  const rows = data as { amount: string | number }[];
  let spend = 0;
  for (const row of rows) {
    const n = Number(row.amount);
    if (Number.isFinite(n)) spend += n;
  }
  return {
    filteredSpend: spend,
    filteredCount: rows.length,
    totalsTruncated: rows.length >= TOTALS_CAP,
  };
}

export async function getTransaction(id: string): Promise<Transaction | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("transactions")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("getTransaction:", error.message);
    return null;
  }
  return (data as Transaction | null) ?? null;
}

/**
 * Transactions cited by an insight.
 *
 * The coach returns evidence ids so a savings claim can be checked against the
 * rows behind it. Ids that no longer exist are dropped rather than failing the
 * whole panel — a deleted transaction shouldn't break an insight.
 */
export async function getTransactionsByIds(ids: string[]): Promise<Transaction[]> {
  if (ids.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("transactions")
    .select(SELECT)
    .in("id", ids.slice(0, 100))
    .order("occurred_at", { ascending: false });

  if (error) {
    console.error("getTransactionsByIds:", error.message);
    return [];
  }
  return (data as Transaction[]) ?? [];
}

/** Accounts, for the filter dropdown. Archived ones are excluded. */
export async function getAccounts() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, kind, institution, currency")
    .eq("is_archived", false)
    .order("name");

  if (error) {
    console.error("getAccounts:", error.message);
    return [];
  }
  return (
    (data as {
      id: string;
      name: string;
      kind: string;
      institution: string | null;
      currency: string;
    }[]) ?? []
  );
}
