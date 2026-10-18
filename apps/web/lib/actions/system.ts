"use server";

import { accessToken } from "@/lib/supabase/server";
import { FUNCTIONS_URL } from "@/lib/env";

/**
 * Backend health probe.
 *
 * The edge functions are deployed separately from this app, so "the backend is
 * not there yet" is a real and common state during development. Rather than
 * letting the user discover that through a failed upload, this says so
 * explicitly.
 *
 * Detection relies on status codes rather than response bodies:
 *
 *   404  -> the slug does not exist, so it is not deployed
 *   405  -> it exists but rejects GET (all six are POST-only). Deployed.
 *   401  -> it exists and the platform rejected the token. Deployed.
 *   200  -> it exists and answered. Deployed.
 *
 * A probe is a GET on purpose: every one of these functions answers anything
 * other than POST with 405 before touching the database, so this cannot trigger
 * a mutation, spend a model call, or write a row.
 */

export const FUNCTION_SLUGS = [
  { slug: "ingest", purpose: "parse and import a statement" },
  { slug: "categorize", purpose: "categorize rows the resolver could not place" },
  { slug: "coach", purpose: "find savings opportunities" },
  { slug: "coach-cron", purpose: "run the coach on a schedule" },
  { slug: "notify", purpose: "push insights to Telegram" },
  { slug: "correct", purpose: "record a correction and learn an alias" },
] as const;

export type ProbeResult = {
  slug: string;
  purpose: string;
  deployed: boolean;
  status: number | null;
  detail: string;
};

export async function checkBackend(): Promise<{
  results: ProbeResult[];
  baseUrl: string;
  seconds: number;
}> {
  const started = Date.now();
  const token = await accessToken();

  const results = await Promise.all(
    FUNCTION_SLUGS.map(async ({ slug, purpose }): Promise<ProbeResult> => {
      try {
        const response = await fetch(`${FUNCTIONS_URL}/${slug}`, {
          method: "GET",
          // Sent when available so a 401 means "the platform rejected it"
          // rather than "no token was supplied" — both still prove deployment.
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        });

        return {
          slug,
          purpose,
          deployed: response.status !== 404,
          status: response.status,
          detail: describe(response.status),
        };
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        return {
          slug,
          purpose,
          deployed: false,
          status: null,
          detail: timedOut
            ? "no response within 8s"
            : `unreachable — ${err instanceof Error ? err.message : "network error"}`,
        };
      }
    }),
  );

  return { results, baseUrl: FUNCTIONS_URL, seconds: (Date.now() - started) / 1000 };
}

function describe(status: number): string {
  switch (status) {
    case 200:
      return "responded";
    case 401:
      return "deployed — rejected the request without a valid token, as it should";
    case 405:
      return "deployed — POST only, so a GET is refused";
    case 404:
      return "not deployed";
    case 503:
      return "deployed but unavailable — cold start or a missing secret";
    default:
      return `deployed — answered ${status}`;
  }
}
