/**
 * Environment access.
 *
 * Everything is read through here so a missing variable fails once, at startup,
 * with a message that says what to do — instead of surfacing as a confusing
 * fetch error deep inside a Server Component.
 *
 * Note what is deliberately absent: there is no service-role key in this app.
 * The Next.js server talks to Supabase as the signed-in user, so row-level
 * security applies to every query. Only the edge functions hold the
 * service-role key, and they hold it in Supabase secrets, never in this repo.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function missing(name: string): never {
  throw new Error(
    `${name} is not set.\n\n` +
      `  cd apps/web\n` +
      `  cp .env.example .env.local\n` +
      `  # then fill in the value from Supabase -> Project Settings -> API Keys\n`,
  );
}

export const SUPABASE_URL: string = url ?? missing("NEXT_PUBLIC_SUPABASE_URL");
export const SUPABASE_ANON_KEY: string = anonKey ?? missing("NEXT_PUBLIC_SUPABASE_ANON_KEY");

/** Base URL of the deployed edge functions. */
export const FUNCTIONS_URL: string =
  process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL ?? `${SUPABASE_URL}/functions/v1`;

/**
 * True once the functions respond. Used by the UI to explain why an upload
 * failed instead of showing a bare network error — the backend is deployed
 * separately from the frontend and may not be there yet.
 */
export function functionName(slug: string): string {
  return `${FUNCTIONS_URL}/${slug}`;
}
