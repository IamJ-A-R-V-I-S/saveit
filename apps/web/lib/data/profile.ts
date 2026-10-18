import "server-only";
import { cache } from "react";
import { createClient, currentUser } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/types";

/**
 * Reads for the signed-in user's profile.
 *
 * NOTE on scoping: none of the queries in lib/data add `.eq('user_id', …)`.
 * That filter is what row-level security already applies (migration 0002), and
 * it applies to the `security_invoker` views too. Duplicating it here would
 * mean the app's correctness depended on remembering the filter in ~20 places
 * instead of once in the database. If a query ever returns another tenant's
 * row, the bug is in a policy, and the fix belongs there.
 */

export const getProfile = cache(async (): Promise<ProfileRow | null> => {
  const user = await currentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("getProfile:", error.message);
    return null;
  }
  return (data as ProfileRow | null) ?? null;
});

export const getUser = cache(async () => {
  return currentUser();
});
