/**
 * POST /functions/v1/coach-cron
 *
 * The scheduled fan-out. pg_cron -> pg_net -> here -> coach, once per user.
 *
 * Auth is a shared secret in the `x-cron-secret` header, NOT a Supabase JWT:
 * pg_cron has no user identity to present. The secret only grants the ability to
 * trigger a run; the actual database work is done with this function's own
 * service-role key from the environment, which never appears in the cron job
 * definition (see migration 0007 for why that matters).
 *
 * Deploy with verify_jwt = false.
 */

import { corsHeaders, fail, json, serviceClient } from '../_shared/db.ts';

/** Users processed concurrently. Kept low: each user costs at least one LLM
 *  call against a shared free-tier key, and hammering it invites 429s. */
const CONCURRENCY = 2;
/** Hard ceiling per run, so a growing user base cannot make one cron tick run
 *  for hours and overlap the next one. */
const MAX_USERS_PER_RUN = 200;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('use POST', 405);

  const expected = Deno.env.get('CRON_SECRET');
  if (!expected) return fail('CRON_SECRET is not configured', 501);

  const presented = req.headers.get('x-cron-secret')
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';

  // Constant-time comparison: this secret is the only thing guarding an endpoint
  // that spends money on every user's behalf.
  if (!timingSafeEqual(presented, expected)) return fail('invalid cron secret', 401);

  const body = (await req.json().catch(() => ({}))) as {
    reason?: string;
    months?: number;
    userId?: string;
  };

  const admin = serviceClient();
  const base = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !serviceKey) return fail('SUPABASE_URL / service key missing', 500);

  // A targeted run (one user) is useful for testing without waiting for Monday.
  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, email, telegram_enabled')
    .order('created_at')
    .limit(MAX_USERS_PER_RUN)
    .match(body.userId ? { id: body.userId } : {});

  if (error) return fail(`profile query failed: ${error.message}`, 500);
  if (!profiles || profiles.length === 0) return json({ processed: 0, reason: 'no users' });

  const results: Array<{ userId: string; status: string; opportunities?: number; error?: string }> = [];
  const queue = [...profiles];

  const worker = async () => {
    for (;;) {
      const profile = queue.shift();
      if (!profile) return;
      try {
        const res = await fetch(`${base}/functions/v1/coach`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            userId: profile.id,
            months: body.months ?? 3,
            // Only push to users who opted in. An unexpected Telegram message is
            // the fastest way to get a bot blocked.
            push: profile.telegram_enabled === true,
          }),
        });

        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (!res.ok) {
          results.push({
            userId: profile.id as string,
            status: 'error',
            error: String(data.error ?? `HTTP ${res.status}`).slice(0, 300),
          });
          continue;
        }

        const opps = Array.isArray(data.opportunities) ? data.opportunities.length : 0;
        results.push({ userId: profile.id as string, status: 'ok', opportunities: opps });

        // Notify even when the coach found nothing, but only on the monthly run
        // and only if the user has opted in. A weekly "nothing to report" is noise.
        if (profile.telegram_enabled === true && opps === 0 && body.reason === 'monthly') {
          await fetch(`${base}/functions/v1/notify`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({
              userId: profile.id,
              message: '📊 SaveIt monthly check: no new savings opportunities found. ' +
                'Your spending looks steady.',
            }),
          }).catch(() => {});
        }
      } catch (err) {
        results.push({
          userId: profile.id as string,
          status: 'error',
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ok = results.filter((r) => r.status === 'ok').length;
  const errors = results.filter((r) => r.status === 'error');

  console.log(`coach-cron (${body.reason ?? 'manual'}): ${ok} ok, ${errors.length} failed`);

  return json({
    reason: body.reason ?? 'manual',
    processed: results.length,
    ok,
    failed: errors.length,
    totalOpportunities: results.reduce((s, r) => s + (r.opportunities ?? 0), 0),
    errors: errors.slice(0, 20),
  });
});

/** Length-safe constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  // Different lengths leak nothing useful here, but comparing unequal-length
  // buffers byte-wise would throw, so short-circuit on length first.
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}
