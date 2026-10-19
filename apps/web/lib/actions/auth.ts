"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth actions.
 *
 * Signup does not insert a profile row: the `handle_new_user` trigger
 * (migration 0001) creates it from the auth user. Doing it in a trigger means a
 * user created by any path — this form, the Supabase dashboard, an invite —
 * gets the same setup, and there is no window where an account exists without a
 * profile. The first-run taxonomy seed happens in `ingest`, not here, because
 * seeding 148 products for someone who never uploads anything is waste.
 */

export type ActionResult =
  | { ok: true; needsEmailConfirmation?: boolean }
  | { ok: false; error: string };

export async function signUp(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim() || null;

  if (!email || !password) return { ok: false, error: "Email and password are required." };
  if (password.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${await baseUrl()}/auth/callback`,
    },
  });

  if (error) return { ok: false, error: friendlyAuthError(error.message) };

  // With email confirmation enabled, signUp returns a user but NO session.
  // Sending that person to the dashboard would show an empty app and look
  // broken, so the form reports it and shows "check your inbox" instead.
  if (!data.session) return { ok: true, needsEmailConfirmation: true };

  redirect("/onboarding");
}

export async function signIn(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) return { ok: false, error: "Email and password are required." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) return { ok: false, error: friendlyAuthError(error.message) };

  const next = String(formData.get("next") ?? "") || "/dashboard";
  // Same-origin relative paths only. An absolute or protocol-relative `next`
  // would turn the login form into an open redirect.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

/**
 * Supabase auth errors are written for developers. These are the ones a person
 * signing up or signing in will actually hit.
 */
function friendlyAuthError(message: string): string {
  if (/already registered|already been registered/i.test(message)) {
    return "An account with that email already exists. Try signing in.";
  }
  if (/invalid login credentials/i.test(message)) {
    return "That email and password don't match. Check and try again.";
  }
  if (/email not confirmed/i.test(message)) {
    return "Your email isn't confirmed yet. Check your inbox for the link.";
  }
  if (/password should be at least/i.test(message)) {
    return "That password is too short — use at least 8 characters.";
  }
  if (/rate limit|too many requests/i.test(message)) {
    return "Too many attempts. Wait a minute and try again.";
  }
  return message;
}
