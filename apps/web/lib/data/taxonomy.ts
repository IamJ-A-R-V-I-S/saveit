import "server-only";
import { createClient } from "@/lib/supabase/server";
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
 * `Cha` and `chai` and `Cha (evening)` are the same thing described three ways.
 * Candidates are products in the same sector whose normalized names are
 * prefixes of each other or differ only by punctuation — the same signal the
 * resolver's canonicalization uses, surfaced so a human can confirm it.
 */
export async function getMergeCandidates(): Promise<
  { keep: Product; drop: Product; reason: string }[]
> {
  const products = await getProducts({ limit: 1000 });
  const bySector = new Map<string, Product[]>();
  for (const p of products) {
    const bucket = bySector.get(p.sector_id);
    if (bucket) bucket.push(p);
    else bySector.set(p.sector_id, [p]);
  }

  const out: { keep: Product; drop: Product; reason: string }[] = [];

  for (const group of bySector.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const na = a.normalized_name;
        const nb = b.normalized_name;
        if (na === nb) continue;

        let reason: string | null = null;
        if (na.startsWith(nb) || nb.startsWith(na)) {
          reason = "one name contains the other";
        } else if (strip(na) === strip(nb)) {
          reason = "differ only by spacing";
        } else if (na.length > 3 && nb.length > 3 && levenshtein(na, nb) <= 1) {
          reason = "one character apart";
        }
        if (!reason) continue;

        // The more-used product survives; it carries the aliases and the
        // history. `merge_products` enforces this too, but choosing here means
        // the UI shows the merge in the direction it will actually happen.
        const [keep, drop] = a.use_count >= b.use_count ? [a, b] : [b, a];
        out.push({ keep, drop, reason });
      }
    }
  }

  // Highest-impact first: merging two products used 400 times each matters more
  // than merging two used twice.
  return out.sort((x, y) => y.keep.use_count + y.drop.use_count - (x.keep.use_count + x.drop.use_count));
}

function strip(s: string): string {
  return s.replace(/[^a-z0-9]/g, "");
}

/** Small on purpose — only ever called on short product names. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
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
