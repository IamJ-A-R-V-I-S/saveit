import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * The client is scoped to the signed-in user's session cookie, so row-level
 * security filters every query. There is no service-role client in this app on
 * purpose — if one existed here, a single missed `.eq('user_id', …)` would leak
 * another tenant's ledger.
 *
 * `cookies()` is async in Next 15+, and in a Server Component it is read-only.
 * `setAll` is therefore wrapped: it succeeds inside Actions and Route Handlers
 * and is a no-op during render, which is the documented Supabase pattern.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Rendering a Server Component. The proxy refreshes the session on
          // every request, so a failed write here is harmless.
        }
      },
    },
  });
}

/**
 * The signed-in user, or null.
 *
 * Uses `getUser()` (which round-trips to the auth server) rather than
 * `getSession()` (which trusts the local JWT) because this is the single gate
 * every page and action passes through. A forged or expired cookie must not be
 * believed.
 */
export async function currentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * The user's access token, for calling edge functions.
 *
 * Edge functions authenticate the caller with
 * `admin.auth.getUser(bearerToken)`, so they need this user JWT — the anon key
 * would identify the app, not the person, and every request would 401.
 */
export async function accessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
