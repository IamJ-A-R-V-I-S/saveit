import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /auth/callback?code=…
 *
 * Landing target for the email-confirmation link. Supabase's own hosted
 * callback is not used because it is not part of this app's routing and would
 * land the user somewhere that does not know about onboarding.
 *
 * The code is single-use and short-lived, so every failure path redirects
 * rather than rendering — a re-render of this route would try to exchange the
 * same code twice and always fail the second time.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next");

  // Same-origin relative paths only: an attacker-controlled `next` would turn
  // the confirmation flow into an open redirect.
  const target =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/onboarding";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=could-not-confirm`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("auth callback:", error.message);
    return NextResponse.redirect(`${origin}/login?error=could-not-confirm`);
  }

  return NextResponse.redirect(`${origin}${target}`);
}
