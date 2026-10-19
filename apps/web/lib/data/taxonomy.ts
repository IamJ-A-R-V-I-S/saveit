import "server-only";
import { createClient } from "@/lib/supabase/server";
import { findMergeCandidates, pairKey } from "@/lib/taxonomy-candidates";
import type { Product } from "@/lib/types";

/**
 * The living taxonomy.
 *
 * Sectors are fixed (14, seeded, read-only). Products grow: ingest creates one
 * the first time a description appears, `correct` re-parents them, and
 * `merge_products` collapses near-duplicates. `use_count` is maintained by
 * trigger (migration 0008) and ranks products by how much of the user's life
 * they actually cover.
 */

const PRODUCT_SELECT = `
  *,
  sector:sectors ( slug, name, icon )
`;

export async function getProducts(options: {
  sectorSlug?: string | null;
  search?: string | null;
  includeInactive?: boolean;
  limit?: number;
} = {}): Promise<Product[]> {
  const { sectorSlug, search, includeInactive = false, limit = 500 } = options;
  const supabase = await createClient();

  let query = supabase.from("products").select(PRODUCT_SELECT);
  if (!includeInactive) query = query.eq("status", "active");
  if (search?.trim()) {
    query = query.ilike("name", `%${search.trim().replace(/[%,()]/g, " ")}%`);
  }
  if (sectorSlug) {
    const { data: sector } = await supabase
      .from("sectors")
      .select("id")
      .eq("slug", sectorSlug)
      .maybeSingle();
    if (!sector) return [];
    query = query.eq("sector_id", sector.id);
  }

  const { data, error } = await query.order("use_count", { ascending: false }).limit(limit);

  if (error) {
    console.error("getProducts:", error.message);
    return [];
  }
  return (data as Product[]) ?? [];
}

/**
 * Products grouped under their sector, with spend attached for the current
 * window. This is the "how do you describe your money" screen.
 */
export async function getTaxonomyTree(): Promise<
  { sector: { id: string; slug: string; name: string; icon: string | null }; products: Product[] }[]
> {
  const supabase = await createClient();
  const [{ data: sectors }, { data: products }] = await Promise.all([
    supabase.from("sectors").select("id, slug, name, icon").order("sort_order"),
    supabase
      .from("products")
      .select(PRODUCT_SELECT)
      .eq("status", "active")
      .order("use_count", { ascending: false })
      .limit(1000),
  ]);

  if (!sectors) return [];
  const list = (products as Product[]) ?? [];

  return (sectors as { id: string; slug: string; name: string; icon: string | null }[]).map(
    (sector) => ({
      sector,
      products: list.filter((p) => p.sector_id === sector.id),
    }),
  );
}

/**
 * Near-duplicate candidates for merging.
 *
 * The rules live in `lib/taxonomy-candidates.ts` so they can be unit-tested
 * without a database (`scripts/test-merge-candidates.mjs`). This function only
 * supplies the products and removes pairs the user has already said are
 * different — a suggestion that comes back after every reload is not a hint,
 * it is nagging.
 *
 * Merging is destructive (every transaction on one product is repointed at the
 * other), so the rules deliberately only catch spelling variance. Sharing a word
 * is not evidence of being the same thing: Ruti and Ruti-tarka, Kachori paratha
 * and Kachori paratha egg are different dishes and are not offered.
 */
export async function getMergeCandidates(): Promise<
  { keep: Product; drop: Product; reason: string }[]
> {
  const [products, dismissed] = await Promise.all([getProducts({ limit: 1000 }), getDismissedPairs()]);

  return findMergeCandidates(products).filter(
    (candidate) => !dismissed.has(pairKey(candidate.keep.id, candidate.drop.id)),
  );
}

/**
 * Pairs the user has marked "not a duplicate", keyed by `pairKey()`.
 *
 * Reads the table added in migration 0010. If that migration has not been
 * applied yet the queue still works — it just cannot remember a dismissal — so a
 * missing table degrades to "nothing dismissed" instead of a broken page.
 */
async function getDismissedPairs(): Promise<Set<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_merge_dismissals")
    .select("product_a_id, product_b_id");

  if (error) {
    // 42P01 = undefined_table. Expected on a project that predates 0010.
    if (error.code !== "42P01") console.error("getDismissedPairs:", error.message);
    return new Set();
  }

  return new Set(
    (data ?? []).map((row: { product_a_id: string; product_b_id: string }) =>
      pairKey(row.product_a_id, row.product_b_id),
    ),
  );
}

/** Aliases the user's corrections have taught the system. */
export async function getAliases(limit = 200) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("aliases")
    .select("*, product:products ( name, sector:sectors ( slug, name ) )")
    .order("hit_count", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getAliases:", error.message);
    return [];
  }
  return (
    (data as {
      id: string;
      pattern: string;
      pattern_type: string;
      source: string;
      confidence: string | number;
      hit_count: number;
      product: { name: string; sector: { slug: string; name: string } | null } | null;
    }[]) ?? []
  );
}
