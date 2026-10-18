"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

/**
 * Browser client, for `use client` components that need to react to auth
 * changes (the sign-out button, the session-expiry banner).
 *
 * Data reads deliberately do NOT go through this. Pages fetch on the server so
 * the initial render already has data and no spinner flashes on navigation.
 */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
