/**
 * First-run taxonomy seeding.
 *
 * A new user with zero products would otherwise force the model to invent a
 * product for every row of their first import. Seeding from the 147 known
 * categories is what makes that first import almost entirely free -- see the
 * measurement in docs/DATA-PROFILE.md §4.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SECTOR_PRODUCTS, canonicalProductName, normalizeProductName } from './taxonomy-seed.ts';

export interface SeedResult {
  seeded: boolean;
  sectors: number;
  products: number;
}

/**
 * Seed a user's product list if it is empty.
 *
 * Idempotent and safe to call on every ingest: it returns early once the user
 * has any active products, so it never overwrites a taxonomy the user (or the
 * model) has since curated.
 */
export async function seedTaxonomyIfEmpty(
  admin: SupabaseClient,
  userId: string,
): Promise<SeedResult> {
  const { count, error: countErr } = await admin
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active');

  if (countErr) throw new Error(`failed to count products: ${countErr.message}`);
  if ((count ?? 0) > 0) return { seeded: false, sectors: 0, products: count ?? 0 };

  const { data: sectorRows, error: sectorErr } = await admin
    .from('sectors')
    .select('id, slug');
  if (sectorErr) throw new Error(`failed to load sectors: ${sectorErr.message}`);

  const sectorBySlug = new Map<string, string>();
  for (const s of sectorRows ?? []) sectorBySlug.set(s.slug as string, s.id as string);

  const uncategorizedId = sectorBySlug.get('uncategorized');
  if (!uncategorizedId) {
    throw new Error('seed sector "uncategorized" is missing -- run migration 0003');
  }

  const rows: Array<Record<string, unknown>> = [];
  // Guard against two seed entries folding to the same normalized_name. The
  // unique index on (user_id, normalized_name) would reject the second one and
  // fail the entire seed, so keep the first and skip the rest. The unit tests
  // assert this never happens; this is defence in depth.
  const seen = new Set<string>();

  for (const [slug, names] of Object.entries(SECTOR_PRODUCTS)) {
    const sectorId = sectorBySlug.get(slug) ?? uncategorizedId;
    for (const rawName of names) {
      const name = canonicalProductName(rawName);
      const normalized = normalizeProductName(name);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      rows.push({
        user_id: userId,
        sector_id: sectorId,
        name,
        normalized_name: normalized,
        is_seeded: true,
      });
    }
  }

  if (rows.length === 0) return { seeded: false, sectors: 0, products: 0 };

  // Batched insert. onConflict on the partial unique index keeps a concurrent
  // first-import from failing the whole seed.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await admin
      .from('products')
      .upsert(rows.slice(i, i + CHUNK), {
        onConflict: 'user_id,normalized_name',
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`failed to seed products: ${error.message}`);
  }

  return { seeded: true, sectors: sectorBySlug.size, products: rows.length };
}
