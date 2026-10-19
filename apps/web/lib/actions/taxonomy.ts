"use server";

import { revalidatePath } from "next/cache";
import { createClient, currentUser } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/actions/auth";

/**
 * Taxonomy mutations.
 *
 * Products grow on their own during ingest. What a human is needed for is
 * merging: the same thing described three ways (`Cha`, `chai`, `Cha (evening)`)
 * fragments the reporting that the whole point of the app depends on.
 */

/**
 * Collapse a duplicate product into the surviving one.
 *
 * Goes through the `merge_products` RPC rather than a sequence of updates
 * because the move has to be atomic: transactions re-parented, aliases
 * re-parented, `use_count` recalculated, loser archived. Doing it in several
 * round trips would leave the taxonomy inconsistent if any step failed, and
 * `use_count` would drift from reality.
 */
export async function mergeProducts(keepId: string, dropId: string): Promise<ActionResult> {
  if (keepId === dropId) return { ok: false, error: "Pick two different products." };
  if (!keepId || !dropId) return { ok: false, error: "Both products are required." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("merge_products", {
    p_keep_id: keepId,
    p_drop_id: dropId,
  });

  if (error) {
    // The RPC raises 'cannot merge a product into itself' and rejects products
    // belonging to another user. Both surface as a Postgres error string.
    return { ok: false, error: error.message };
  }

  revalidatePath("/taxonomy");
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  revalidatePath("/review");
  return { ok: true };
}

/**
 * Create a product the user wants before any transaction has used it.
 *
 * `normalized_name` must match what the resolver's canonicalizer produces, or
 * the unique partial index (migration 0006) will treat it as a different
 * product and descriptions will keep missing it. The same rule is applied here
 * as in `_shared/taxonomy.ts`: lowercase, strip everything that is not a letter
 * or digit.
 */
export async function createProduct(input: {
  name: string;
  sectorSlug: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "A product name is required." };
  if (name.length > 80) return { ok: false, error: "Keep the name under 80 characters." };

  const supabase = await createClient();
  const user = await currentUser();
  if (!user) return { ok: false, error: "You are signed out." };

  const { data: sector } = await supabase
    .from("sectors")
    .select("id")
    .eq("slug", input.sectorSlug)
    .maybeSingle();
  if (!sector?.id) return { ok: false, error: `Unknown sector "${input.sectorSlug}".` };

  const { data, error } = await supabase
    .from("products")
    .insert({
      user_id: user.id,
      sector_id: sector.id,
      name,
      normalized_name: canonicalize(name),
      status: "active",
      is_seeded: false,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `You already have a product called "${name}" in that sector.` };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/taxonomy");
  revalidatePath("/review");
  return { ok: true, id: data.id as string };
}

/** Mirrors `canonicalizeName` in `_shared/taxonomy.ts`. */
function canonicalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * Move a product to a different sector.
 *
 * Useful when the model put something plausible-but-wrong, and cheaper than
 * deleting and recreating: the name keeps its aliases and its history.
 */
export async function moveProduct(productId: string, sectorSlug: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: sector } = await supabase
    .from("sectors")
    .select("id")
    .eq("slug", sectorSlug)
    .maybeSingle();
  if (!sector?.id) return { ok: false, error: `Unknown sector "${sectorSlug}".` };

  const { error } = await supabase
    .from("products")
    .update({ sector_id: sector.id })
    .eq("id", productId);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/taxonomy");
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  revalidatePath("/review");
  return { ok: true };
}
