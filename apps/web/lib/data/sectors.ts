import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Sector } from "@/lib/types";

/**
 * Sectors are global and read-only — 14 fixed rows seeded by migration 0003.
 *
 * Keeping them fixed is the "hybrid taxonomy" decision: reporting stays
 * comparable month over month even though the products underneath grow and
 * merge. The RLS policy grants authenticated users SELECT only, so no code path
 * here can accidentally mutate them.
 */
export async function getSectors(): Promise<Sector[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sectors")
    .select("*")
    .order("sort_order");

  if (error) {
    console.error("getSectors:", error.message);
    return [];
  }
  return (data as Sector[]) ?? [];
}

/** slug -> Sector, for labelling rows without a second round trip. */
export async function getSectorsBySlug(): Promise<Map<string, Sector>> {
  const sectors = await getSectors();
  return new Map(sectors.map((s) => [s.slug, s]));
}
