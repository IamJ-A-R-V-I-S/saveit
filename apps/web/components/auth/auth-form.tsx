"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { signIn, signUp, type ActionResult } from "@/lib/actions/auth";

/**
 * Sign in / sign up form.
 *
 * Uses `useActionState` against a Server Action rather than a client-side
 * Supabase call, so the session cookie is written on the server and the action
 * can `redirect()` in the same round trip.
 *
 * The email-confirmation case is handled explicitly: with confirmation enabled,
 * `signUp` succeeds but returns NO session, and rendering a blank dashboard
 * would look like a broken app. So the form swaps to a "check your inbox" state.
 */

type State = {
  error?: string;
  needsEmailConfirmation?: boolean;
  email?: string;
};

export function AuthForm({ mode, next }: { mode: "signin" | "signup"; next?: string | null }) {
  const isSignup = mode === "signup";
  const action = isSignup ? signUp : signIn;

  const [state, formAction, pending] = useActionState<State, FormData>(
    async (_prev: State, formData: FormData): Promise<State> => {
      const result = (await action(formData)) as ActionResult;
      if (!result.ok) return { error: result.error };
      if ("needsEmailConfirmation" in result && result.needsEmailConfirmation) {
        return {
          needsEmailConfirmation: true,
          email: String(formData.get("email") ?? ""),
        };
      }
      // A successful action redirects, so this is only reached if it didn't.
      return {};
    },
    {},
  );

  /*
   * Sent by the proxy when a signed-out visitor hits a protected route.
   *
   * Passed in as a prop from the server page rather than read from
   * `window.location` in an effect: the page already has `searchParams`, so this
   * needs no client-only API, no Suspense boundary and no second render to
   * discover the value.
   */
  const nextParam = next && next.startsWith("/") && !next.startsWith("//") ? next : "";

  const passwordRef = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!passwordRef.current) return;
    // Validating in `onInput` rather than on submit means the message appears
    // while the person is still typing, not after they have committed to it.
    const el = passwordRef.current;
    const check = () =>
      setHint(el.value.length > 0 && el.value.length < 8 ? "At least 8 characters" : null);
    el.addEventListener("input", check);
    return () => el.removeEventListener("input", check);
  }, []);

  if (state.needsEmailConfirmation) {
    return (
      <div className="card px-6 py-8 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-accent-soft text-xl">
          ✉️
        </div>
        <h1 className="mt-4 text-lg font-semibold tracking-tight">Check your inbox</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          We sent a confirmation link to{" "}
          <span className="font-medium text-ink">{state.email}</span>. Click it, then come back and
          sign in.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="card px-6 py-7">
      <h1 className="text-lg font-semibold tracking-tight">
        {isSignup ? "Create your account" : "Sign in"}
      </h1>
      <p className="mt-1 text-sm text-muted">
        {isSignup
          ? "Your taxonomy seeds itself on the first upload."
          : "Pick up where you left off."}
      </p>

      <form action={formAction} className="mt-6 space-y-4" noValidate>
        {nextParam ? <input type="hidden" name="next" value={nextParam} /> : null}

        {isSignup ? (
          <div>
            <label className="label" htmlFor="fullName">
              Name <span className="font-normal text-faint">(optional)</span>
            </label>
            <input
              id="fullName"
              name="fullName"
              type="text"
              autoComplete="name"
              className="field"
              placeholder="What should the coach call you?"
            />
          </div>
        ) : null}

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="field"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            ref={passwordRef}
            autoComplete={isSignup ? "new-password" : "current-password"}
            className="field"
            placeholder="At least 8 characters"
            aria-describedby={hint ? "password-hint" : undefined}
          />
          {hint ? (
            <p id="password-hint" className="mt-1.5 text-xs text-warning">
              {hint}
            </p>
          ) : null}
        </div>

        {state.error ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger"
          >
            {state.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Working…" : isSignup ? "Create account" : "Sign in"}
        </button>
      </form>

      <p className="mt-5 text-center text-xs text-muted">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-semibold text-accent hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link href="/signup" className="font-semibold text-accent hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
