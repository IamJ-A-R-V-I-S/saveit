import "server-only";
import { accessToken } from "@/lib/supabase/server";
import { functionName } from "@/lib/env";

/**
 * Call a Supabase edge function as the signed-in user.
 *
 * This is the backend-for-frontend boundary. The browser never talks to the
 * functions directly: the request is assembled on the server, which is where the
 * user's access token lives. The token is forwarded verbatim because every
 * function resolves the caller with `admin.auth.getUser(bearerToken)` — the anon
 * key would identify the app rather than the person and every call would 401.
 */

export class EdgeFunctionError extends Error {
  /** HTTP status, or 0 when the call never reached a server. */
  readonly status: number;
  /** Set when the function is not deployed at all, as opposed to erroring. */
  readonly notDeployed: boolean;
  /** Whatever the function put in the body, when it was JSON. */
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown = null) {
    super(message);
    this.name = "EdgeFunctionError";
    this.status = status;
    this.payload = payload;
    // Supabase answers 404 with a plain-text body when the slug does not exist.
    this.notDeployed =
      status === 404 ||
      status === 0 ||
      (typeof message === "string" &&
        /function not found|not found|failed to fetch|edge function/i.test(message));
  }
}

type CallOptions = {
  /** Request body. Omitted for multipart calls, which build their own. */
  body?: unknown;
  /** Pre-built request, used for multipart uploads. */
  init?: RequestInit;
  /** Milliseconds. Ingest of a large statement and coach runs are slow. */
  timeoutMs?: number;
};

export async function callFunction<T = unknown>(
  slug: string,
  options: CallOptions = {},
): Promise<T> {
  const token = await accessToken();
  if (!token) {
    throw new EdgeFunctionError("You are signed out. Sign in again to continue.", 401);
  }

  const { body, init, timeoutMs = 120_000 } = options;

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(functionName(slug), {
      ...init,
      method: init?.method ?? "POST",
      headers,
      // The browser client is server-side here; never cache a mutation.
      cache: "no-store",
      body: body !== undefined ? JSON.stringify(body) : init?.body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new EdgeFunctionError(
      aborted
        ? `${slug} timed out after ${Math.round(timeoutMs / 1000)}s. A large statement can take a while — check the Documents list before retrying, or you may import it twice.`
        : `Could not reach the ${slug} function. Is it deployed?`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  // Functions return JSON, but a platform-level failure (cold start, crash)
  // returns plain text. Parsing defensively keeps the message useful.
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const message =
      (payload as { error?: string; message?: string } | null)?.error ??
      (payload as { message?: string } | null)?.message ??
      (text || `${slug} failed with HTTP ${response.status}`);
    throw new EdgeFunctionError(message, response.status, payload);
  }

  return (payload ?? ({} as T)) as T;
}

/**
 * A human-facing explanation of an edge failure.
 *
 * The functions are deployed separately from the web app, so "not deployed" is
 * an expected state during development and deserves a better message than a raw
 * network error.
 */
export function describeEdgeError(err: unknown): string {
  if (err instanceof EdgeFunctionError) {
    if (err.notDeployed) {
      return `${err.message}\n\nThe SaveIt backend is deployed separately from this app. Run \`supabase functions deploy\` (see the README) and try again.`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
