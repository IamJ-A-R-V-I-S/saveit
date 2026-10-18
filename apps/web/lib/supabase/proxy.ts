import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Routes anyone may see signed out.
 *
 * `/` is public so a visitor can read what SaveIt is before committing to an
 * account; it redirects to the dashboard for people already signed in.
 */
const PUBLIC_PATHS = new Set(["/", "/login", "/signup", "/auth/callback"]);

/** Routes that must bounce a signed-in user back to the app. */
const AUTH_ONLY_PATHS = new Set(["/login", "/signup"]);

/**
 * Refresh the session cookie and enforce optimistic auth redirects.
 *
 * This is the Supabase SSR contract: the proxy reads the session cookie and
 * writes back any refreshed tokens. Skipping it means a user's session expires
 * mid-browsing with no chance to renew, and the next Server Component read
 * silently returns null.
 *
 * It is *optimistic* only — it checks the cookie, not the database. The
 * authoritative check is `currentUser()` in the server layout and in every
 * Server Action, because the proxy runs on prefetched routes too and must stay
 * cheap. See the Next.js authentication guide.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // The anon key is public by design; RLS is what actually protects data.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          // Rebuild from the mutated request so downstream handlers see the new
          // cookies, then copy them onto the outgoing response.
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Do not run code between createServerClient and getUser(): a stray
  // NextResponse returned early would drop the refreshed cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.has(path);

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Preserve where they were going so login can send them back.
    if (path !== "/") url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (user && AUTH_ONLY_PATHS.has(path)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
