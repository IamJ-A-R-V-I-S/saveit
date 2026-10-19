/**
 * Database + quota helpers shared by every edge function.
 *
 * Edge functions run with the service-role key, which bypasses RLS. That is
 * required (the agents read a user's whole history) and it is why every query in
 * this codebase filters on user_id explicitly. There is no RLS safety net here.
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { canonicalAccountName, isCashAccount } from './accounts.ts';
import type { Alias, Product, Sector } from './types.ts';
import { QuotaExceededError } from './llm.ts';
import { normalizeProductName } from './taxonomy-seed.ts';

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Client scoped to one user, for endpoints called from the browser. */
export function userClient(accessToken: string): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  return createClient(url, key, {
    global: { headers: { authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    ...extra,
  };
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ 'content-type': 'application/json' }),
  });
}

export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, status);
}

/** Pull the user id out of the request's JWT. Null when unauthenticated. */
export async function userIdFromRequest(
  req: Request,
  admin: SupabaseClient,
): Promise<string | null> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

// ---------------------------------------------------------------------------
// taxonomy loading
// ---------------------------------------------------------------------------

export async function loadTaxonomy(
  admin: SupabaseClient,
  userId: string,
): Promise<{ sectors: Sector[]; products: Product[]; aliases: Alias[] }> {
  const { data: sectorRows, error: sErr } = await admin
    .from('sectors')
    .select('id, slug, name, icon')
    .order('sort_order');
  if (sErr) throw new Error(`failed to load sectors: ${sErr.message}`);

  const { data: productRows, error: pErr } = await admin
    .from('products')
    .select('id, sector_id, name, normalized_name, use_count')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (pErr) throw new Error(`failed to load products: ${pErr.message}`);

  // Global aliases (user_id is null) plus this user's own.
  const { data: aliasRows, error: aErr } = await admin
    .from('aliases')
    .select('id, product_id, pattern, pattern_type, confidence')
    .or(`user_id.eq.${userId},user_id.is.null`);
  if (aErr) throw new Error(`failed to load aliases: ${aErr.message}`);

  return {
    sectors: (sectorRows ?? []).map((r) => ({
      id: r.id as string,
      slug: r.slug as string,
      name: r.name as string,
      icon: (r.icon as string | null) ?? null,
    })),
    products: (productRows ?? []).map((r) => ({
      id: r.id as string,
      sectorId: r.sector_id as string,
      name: r.name as string,
      normalizedName: r.normalized_name as string,
      useCount: Number(r.use_count ?? 0),
    })),
    aliases: (aliasRows ?? []).map((r) => ({
      id: r.id as string,
      productId: r.product_id as string,
      pattern: r.pattern as string,
      patternType: r.pattern_type as Alias['patternType'],
      confidence: Number(r.confidence),
    })),
  };
}

/**
 * Get or create a product by name within a sector.
 *
 * Idempotent: the unique index on (user_id, normalized_name) where status =
 * 'active' means two concurrent inserts of the same name cannot both land. We
 * re-select on conflict rather than trusting the insert's return value.
 */
export async function ensureProduct(
  admin: SupabaseClient,
  userId: string,
  name: string,
  sectorId: string,
  isSeeded = false,
): Promise<Product | null> {
  const normalizedName = normalizeProductName(name);
  if (!normalizedName) return null;

  const { data: existing } = await admin
    .from('products')
    .select('id, sector_id, name, normalized_name, use_count')
    .eq('user_id', userId)
    .eq('normalized_name', normalizedName)
    .eq('status', 'active')
    .maybeSingle();

  if (existing) {
    return {
      id: existing.id as string,
      sectorId: existing.sector_id as string,
      name: existing.name as string,
      normalizedName: existing.normalized_name as string,
      useCount: Number(existing.use_count ?? 0),
    };
  }

  const { error } = await admin.from('products').insert({
    user_id: userId,
    sector_id: sectorId,
    name,
    normalized_name: normalizedName,
    is_seeded: isSeeded,
  });

  if (error) {
    // Most likely the unique index firing under a concurrent insert. Re-read.
    const { data: raced } = await admin
      .from('products')
      .select('id, sector_id, name, normalized_name, use_count')
      .eq('user_id', userId)
      .eq('normalized_name', normalizedName)
      .eq('status', 'active')
      .maybeSingle();
    if (raced) {
      return {
        id: raced.id as string,
        sectorId: raced.sector_id as string,
        name: raced.name as string,
        normalizedName: raced.normalized_name as string,
        useCount: Number(raced.use_count ?? 0),
      };
    }
    throw new Error(`failed to create product "${name}": ${error.message}`);
  }

  const { data: created } = await admin
    .from('products')
    .select('id, sector_id, name, normalized_name, use_count')
    .eq('user_id', userId)
    .eq('normalized_name', normalizedName)
    .eq('status', 'active')
    .maybeSingle();

  return created
    ? {
        id: created.id as string,
        sectorId: created.sector_id as string,
        name: created.name as string,
        normalizedName: created.normalized_name as string,
        useCount: Number(created.use_count ?? 0),
      }
    : null;
}

/**
 * Get or create an account by name. Cash-like accounts are flagged manual_only.
 *
 * Matching on `normalized_name` rather than the whole string is the fix from
 * migration 0012: a statement that says `Slice bank` and one that says `Slice`
 * are the same account. The key is computed by `canonicalAccountName()`, which
 * mirrors the database-side function the trigger uses.
 *
 * Archived accounts are skipped. After a merge the losing row is archived, not
 * deleted, so a later statement using its old spelling must land on the
 * surviving account — which now owns the same normalized name.
 */
export async function ensureAccount(
  admin: SupabaseClient,
  userId: string,
  name: string,
): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;

  const normalizedName = canonicalAccountName(clean);

  if (normalizedName) {
    const { data: existing, error: readError } = await admin
      .from('accounts')
      .select('id, name')
      .eq('user_id', userId)
      .eq('normalized_name', normalizedName)
      .eq('is_archived', false)
      .order('created_at', { ascending: true });

    if (readError) {
      throw new Error(`failed to look up account "${clean}": ${readError.message}`);
    }

    if (existing && existing.length > 0) {
      // The index is deliberately not unique (0012), so a tenant that predates
      // the migration can have two active rows with the same key. Prefer the
      // exact spelling from the statement; otherwise the oldest row, so repeat
      // imports keep landing on the same account instead of oscillating.
      const exact = existing.find(
        (row) => (row.name as string).trim().toLowerCase() === clean.toLowerCase(),
      );
      return (exact ?? existing[0]).id as string;
    }
  }

  const cash = isCashAccount(clean);

  const { data: created, error } = await admin
    .from('accounts')
    .insert({
      user_id: userId,
      name: clean,
      // The trigger computes this too. Sending it explicitly makes the insert
      // readable, and keeps the row correct on a project where the trigger has
      // not been added yet.
      normalized_name: normalizedName,
      kind: cash ? 'cash' : 'bank',
      manual_only: cash,
      currency: 'INR',
    })
    .select('id')
    .single();

  if (error) throw new Error(`failed to create account "${clean}": ${error.message}`);
  return created?.id as string ?? null;
}

// ---------------------------------------------------------------------------
// LLM quota
// ---------------------------------------------------------------------------

/**
 * How many LLM calls this user has already made today (UTC).
 *
 * Enforced BEFORE the call, not after: on a free-tier key a single tenant
 * running a 5,000-row import must not be able to exhaust the quota everyone
 * else depends on.
 */
export async function llmCallsToday(admin: SupabaseClient, userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await admin
    .from('llm_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', startOfDay.toISOString());

  if (error) throw new Error(`failed to read llm_usage: ${error.message}`);
  return count ?? 0;
}

export async function assertQuota(
  admin: SupabaseClient,
  userId: string,
  needed = 1,
): Promise<{ used: number; cap: number }> {
  const { data: profile } = await admin
    .from('profiles')
    .select('llm_daily_cap')
    .eq('id', userId)
    .maybeSingle();

  const cap = Number(profile?.llm_daily_cap ?? 200);
  const used = await llmCallsToday(admin, userId);
  if (used + needed > cap) throw new QuotaExceededError(used, cap);
  return { used, cap };
}

export async function recordLlmUsage(
  admin: SupabaseClient,
  userId: string,
  fn: string,
  usage: { provider: string; model: string; promptTokens: number; completionTokens: number },
): Promise<void> {
  await admin.from('llm_usage').insert({
    user_id: userId,
    fn,
    model: usage.model,
    provider: usage.provider,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    calls: 1,
  });
}
