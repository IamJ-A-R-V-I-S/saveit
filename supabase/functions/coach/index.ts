/**
 * POST /functions/v1/coach
 *
 *   {}                                  analyze the most recent complete month
 *   {"months": 3}                       analyze a trailing window
 *   {"push": true}                      also send the result to Telegram
 *
 * Also invoked by pg_cron (see migration 0007) with the service role.
 *
 * ---------------------------------------------------------------------------
 * THE ANTI-HALLUCINATION CONTRACT
 * ---------------------------------------------------------------------------
 * The model is NOT asked to find the savings opportunities, and it is NOT asked
 * for transaction ids. SQL finds the candidates and attaches real ids. The model
 * only ranks them, estimates a saving, and writes the sentence. It refers to a
 * candidate by its index, and we look the evidence up ourselves.
 *
 * This means an insight can be badly worded or poorly prioritised, but it can
 * never cite a transaction that does not exist. Every claim in the UI is
 * clickable down to real rows.
 */

import {
  assertQuota, corsHeaders, fail, json, recordLlmUsage, serviceClient,
  userIdFromRequest,
} from '../_shared/db.ts';
import { completeJson, QuotaExceededError } from '../_shared/llm.ts';

/** How many transaction ids to attach as clickable evidence per candidate. */
const EVIDENCE_LIMIT = 12;
const MAX_CANDIDATES = 14;

interface Candidate {
  index: number;
  kind: 'frequency' | 'spike' | 'concentration' | 'recurring';
  sectorSlug: string | null;
  productName: string | null;
  spend: number;
  txCount: number;
  avgTicket: number | null;
  detail: string;
  evidence: string[];
}

const SYSTEM = `You are a personal-finance coach. You are given PRE-COMPUTED
spending candidates. You did not compute them and you must not invent numbers.

Return ONLY a JSON object: {"opportunities": [...]} ranked best-first, at most 6.

Each opportunity:
  candidateIndex  integer -- which candidate this is about. REQUIRED.
  headline        string  -- <= 90 chars, specific, names the product and the
                           number. e.g. "Chai and cola: 1,071 buys, Rs 11,892"
  detail          string  -- <= 280 chars. What the pattern is, and ONE concrete
                            action. Be direct, not preachy.
  monthlySavingEstimate  number -- realistic rupees per month this user could
                            keep by acting. Be conservative: assume partial
                            success, never 100% elimination of a habit.
  confidence      number  -- 0..1

Rules:
- Only use candidates you were given. Never reference a candidateIndex that does
  not exist.
- Never state a transaction id, date or amount that is not in the candidate data.
- Skip a candidate if acting on it would be unrealistic (rent, tuition, medicine,
  loan repayment are not savings opportunities).
- Prefer candidates with high transaction counts: many small repeated purchases
  are more compressible than one large one.
- If fewer than 6 candidates are worth acting on, return fewer. An empty list is
  a valid answer and is better than padding.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('use POST', 405);

  const admin = serviceClient();

  try {
    // pg_cron calls with the service role and an explicit user id in the body.
    const body = (await req.json().catch(() => ({}))) as {
      userId?: string;
      months?: number;
      push?: boolean;
    };

    const userId = body.userId ?? await userIdFromRequest(req, admin);
    if (!userId) return fail('unauthenticated', 401);

    const months = Math.max(1, Math.min(body.months ?? 3, 12));

    const { used, cap } = await assertQuota(admin, userId, 1);

    // -- coverage gate --------------------------------------------------------
    // Sparse months produce false "you spent less!" findings. If the most recent
    // month has far fewer transactions than the user's own median, we analyze the
    // trailing window instead and say so.
    const { data: coverage, error: covErr } = await admin
      .from('v_monthly_coverage')
      .select('month, tx_count, total_spend, categorize_pct')
      .eq('user_id', userId)
      .order('month', { ascending: false })
      .limit(14);
    if (covErr) return fail(`coverage query failed: ${covErr.message}`, 500);
    if (!coverage || coverage.length === 0) {
      return json({ opportunities: 0, message: 'no transactions yet -- upload a statement first' });
    }

    const counts = coverage.map((c) => Number(c.tx_count));
    const medianCount = median(counts);
    const latest = coverage[0];
    const latestIsSparse = Number(latest.tx_count) < medianCount * 0.5;

    const windowMonths = coverage.slice(0, latestIsSparse ? months + 1 : months);
    const windowStart = windowMonths[windowMonths.length - 1].month as string;
    const windowEnd = latest.month as string;

    const candidates = await buildCandidates(admin, userId, windowStart, windowEnd, months);

    if (candidates.length === 0) {
      return json({
        opportunities: 0,
        message: 'no savings candidates found in this window',
        window: { start: windowStart, end: windowEnd },
        latestMonthSparse: latestIsSparse,
      });
    }

    // -- ask the model to rank and explain ------------------------------------
    const brief = candidates.map((c) => ({
      index: c.index,
      kind: c.kind,
      sector: c.sectorSlug,
      product: c.productName,
      spend: c.spend,
      transactions: c.txCount,
      avgTicket: c.avgTicket,
      detail: c.detail,
    }));

    const { data, usage } = await completeJson<{
      opportunities?: Array<{
        candidateIndex?: number;
        headline?: string;
        detail?: string;
        monthlySavingEstimate?: number;
        confidence?: number;
      }>;
    }>(
      {
        system: SYSTEM,
        user: `ANALYSIS WINDOW: ${windowStart} to ${windowEnd} (${months} month(s)).\n` +
          `Total transactions in window: ${counts.slice(0, months).reduce((a, b) => a + b, 0)}.\n` +
          (latestIsSparse
            ? `WARNING: the most recent month has only ${latest.tx_count} transactions vs a median of ${medianCount}. Treat it as incomplete.\n`
            : '') +
          `\nCANDIDATES:\n${JSON.stringify(brief)}`,
        temperature: 0.2,
        maxOutputTokens: 3072,
      },
      (u, fn) => recordLlmUsage(admin, userId, fn, u),
      'coach',
    );

    const byIndex = new Map(candidates.map((c) => [c.index, c]));
    const opportunities = (data.opportunities ?? [])
      .map((o, i) => {
        // Ignore any reference to a candidate we did not send. This is the
        // structural guarantee: evidence can only come from our own map.
        const cand = byIndex.get(Number(o.candidateIndex));
        if (!cand) return null;
        return {
          rank: i + 1,
          candidate: cand,
          headline: String(o.headline ?? cand.detail).slice(0, 200),
          detail: String(o.detail ?? '').slice(0, 1000),
          monthlySavingEstimate: Number.isFinite(Number(o.monthlySavingEstimate))
            ? Math.max(0, Number(o.monthlySavingEstimate))
            : null,
          confidence: clamp01(Number(o.confidence ?? 0.5)),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, 6);

    // -- persist --------------------------------------------------------------
    const sectorBySlug = new Map<string, string>();
    const { data: sectorRows } = await admin.from('sectors').select('id, slug');
    for (const s of sectorRows ?? []) sectorBySlug.set(s.slug as string, s.id as string);

    const inserts = opportunities.map((o) => ({
      user_id: userId,
      period_start: windowStart,
      period_end: windowEnd,
      kind: o.candidate.kind === 'spike' ? 'anomaly' : 'opportunity',
      rank: o.rank,
      sector_id: o.candidate.sectorSlug ? sectorBySlug.get(o.candidate.sectorSlug) ?? null : null,
      product_id: null,
      headline: o.headline,
      detail: o.detail,
      monthly_saving_estimate: o.monthlySavingEstimate,
      confidence: o.confidence,
      evidence: o.candidate.evidence,
      status: 'new',
      llm_model: usage.model,
    }));

    if (inserts.length > 0) {
      const { error: insErr } = await admin.from('insights').insert(inserts);
      if (insErr) return fail(`failed to store insights: ${insErr.message}`, 500);
    }

    const result = {
      window: { start: windowStart, end: windowEnd, months },
      latestMonthSparse: latestIsSparse,
      candidatesFound: candidates.length,
      opportunities: opportunities.map((o) => ({
        rank: o.rank,
        kind: o.candidate.kind,
        headline: o.headline,
        detail: o.detail,
        monthlySavingEstimate: o.monthlySavingEstimate,
        confidence: o.confidence,
        sector: o.candidate.sectorSlug,
        product: o.candidate.productName,
        spend: o.candidate.spend,
        txCount: o.candidate.txCount,
        evidenceCount: o.candidate.evidence.length,
        evidence: o.candidate.evidence,
      })),
      totalMonthlySavingPotential: opportunities.reduce(
        (sum, o) => sum + (o.monthlySavingEstimate ?? 0), 0,
      ),
      llmCalls: 1,
      quota: { used: used + 1, cap },
      model: usage.model,
    };

    // -- optional push ---------------------------------------------------------
    if (body.push && opportunities.length > 0) {
      const url = new URL(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notify`);
      try {
        await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: req.headers.get('authorization') ?? '',
          },
          body: JSON.stringify({ userId, insights: result.opportunities, window: result.window }),
        });
      } catch (err) {
        // A failed push must not fail the analysis -- the insights are stored.
        console.error('notify failed:', err instanceof Error ? err.message : String(err));
      }
    }

    return json(result);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return json({ error: err.message, used: err.used, cap: err.cap }, 429);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('coach failed:', msg);
    return fail(msg, 500);
  }
});

// ---------------------------------------------------------------------------
// candidate generation -- pure SQL, real ids, no model involved
// ---------------------------------------------------------------------------

type Admin = ReturnType<typeof serviceClient>;

async function buildCandidates(
  admin: Admin,
  userId: string,
  windowStart: string,
  windowEnd: string,
  months: number,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let index = 0;

  const windowFilter = (q: ReturnType<Admin['from']>) =>
    q.gte('occurred_at', `${windowStart}-01T00:00:00Z`)
      .lt('occurred_at', endExclusive(windowEnd));

  // ---- 1. FREQUENCY: many small repeated purchases -------------------------
  // The single best savings target. The sample's chai+cola cluster is 1,071
  // transactions for Rs 11,892 -- individually trivial, collectively large, and
  // behaviourally compressible in a way rent is not.
  const { data: productSpend } = await admin
    .from('v_monthly_product_spend')
    .select('product_id, product_name, sector_slug, spend, tx_count, avg_ticket, month')
    .eq('user_id', userId)
    .gte('month', `${windowStart}-01`)
    .lte('month', `${windowEnd}-01`);

  const perProduct = new Map<string, { name: string; sector: string | null; spend: number; tx: number }>();
  for (const r of productSpend ?? []) {
    const key = String(r.product_id);
    const cur = perProduct.get(key) ?? {
      name: r.product_name as string,
      sector: (r.sector_slug as string | null) ?? null,
      spend: 0,
      tx: 0,
    };
    cur.spend += Number(r.spend);
    cur.tx += Number(r.tx_count);
    perProduct.set(key, cur);
  }

  const frequencyTargets = [...perProduct.entries()]
    .map(([id, v]) => ({ id, ...v, avg: v.tx > 0 ? v.spend / v.tx : 0 }))
    // Repeated AND small. A single Rs 5,000 laptop is not a habit.
    .filter((v) => v.tx >= 15 && v.avg <= 300 && v.spend >= 500)
    .sort((a, b) => b.tx - a.tx)
    .slice(0, 6);

  for (const t of frequencyTargets) {
    const evidence = await evidenceFor(admin, userId, t.id, windowStart, windowEnd);
    out.push({
      index: index++,
      kind: 'frequency',
      sectorSlug: t.sector,
      productName: t.name,
      spend: round2(t.spend),
      txCount: t.tx,
      avgTicket: round2(t.avg),
      detail: `"${t.name}" bought ${t.tx} times over ${months} month(s), ` +
        `avg Rs ${round2(t.avg)} each, Rs ${round2(t.spend)} total. ` +
        `That is ${(t.tx / months).toFixed(1)} times per month.`,
      evidence,
    });
    if (out.length >= MAX_CANDIDATES) return out;
  }

  // ---- 2. CONCENTRATION: biggest products by spend -------------------------
  const concentration = [...perProduct.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .filter((v) => v.spend >= 2000)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5);

  for (const t of concentration) {
    // Skip anything the coach should never suggest cutting.
    if (isProtected(t.sector)) continue;
    const evidence = await evidenceFor(admin, userId, t.id, windowStart, windowEnd);
    out.push({
      index: index++,
      kind: 'concentration',
      sectorSlug: t.sector,
      productName: t.name,
      spend: round2(t.spend),
      txCount: t.tx,
      avgTicket: t.tx > 0 ? round2(t.spend / t.tx) : null,
      detail: `"${t.name}" is Rs ${round2(t.spend)} over ${months} month(s) across ${t.tx} transactions.`,
      evidence,
    });
    if (out.length >= MAX_CANDIDATES) return out;
  }

  // ---- 3. SPIKE: sector spend vs its own trailing median -------------------
  const { data: sectorMonthly } = await admin
    .from('v_monthly_sector_spend')
    .select('sector_slug, sector_name, month, spend, tx_count')
    .eq('user_id', userId)
    .order('month', { ascending: true });

  const bySector = new Map<string, Array<{ month: string; spend: number; tx: number }>>();
  for (const r of sectorMonthly ?? []) {
    const key = r.sector_slug as string;
    const arr = bySector.get(key) ?? [];
    arr.push({ month: r.month as string, spend: Number(r.spend), tx: Number(r.tx_count) });
    bySector.set(key, arr);
  }

  for (const [slug, series] of bySector) {
    if (isProtected(slug)) continue;
    if (series.length < 4) continue;
    const last = series[series.length - 1];
    const prior = series.slice(0, -1).map((s) => s.spend);
    const med = median(prior);
    if (med <= 0) continue;
    const ratio = last.spend / med;
    // Only a material jump, and only where the absolute amount is worth mentioning.
    if (ratio < 1.35 || last.spend - med < 500) continue;

    const { data: evRows } = await windowFilter(
      admin.from('transactions')
        .select('id')
        .eq('user_id', userId)
        .eq('direction', 'debit')
        .order('amount', { ascending: false })
        .limit(EVIDENCE_LIMIT),
    ).gte('occurred_at', `${last.month}-01T00:00:00Z`);

    out.push({
      index: index++,
      kind: 'spike',
      sectorSlug: slug,
      productName: null,
      spend: round2(last.spend),
      txCount: last.tx,
      avgTicket: null,
      detail: `${slug} spend was Rs ${round2(last.spend)} in ${last.month}, ` +
        `vs a trailing median of Rs ${round2(med)} (${Math.round((ratio - 1) * 100)}% higher).`,
      evidence: (evRows ?? []).map((r) => r.id as string),
    });
    if (out.length >= MAX_CANDIDATES) return out;
  }

  // ---- 4. RECURRING: same amount on a regular cadence ----------------------
  // Subscriptions and rent. Worth surfacing as "you pay this every month, is it
  // still earning its keep?" rather than as a cut candidate.
  const { data: recurring } = await admin.rpc('find_recurring_transactions', {
      p_user_id: userId,
      p_since: `${windowStart}-01`,
    }).catch(() => ({ data: null, error: null })) as { data: Array<Record<string, unknown>> | null; error: unknown };

  for (const r of (recurring ?? []).slice(0, 3)) {
    out.push({
      index: index++,
      kind: 'recurring',
      sectorSlug: (r.sector_slug as string | null) ?? null,
      productName: (r.product_name as string | null) ?? null,
      spend: round2(Number(r.total_spend ?? 0)),
      txCount: Number(r.occurrences ?? 0),
      avgTicket: round2(Number(r.amount ?? 0)),
      detail: `${r.product_name ?? 'a payment'} of Rs ${round2(Number(r.amount ?? 0))} recurs ` +
        `${r.occurrences} times, roughly every ${r.median_gap_days ?? '?'} days.`,
      evidence: ((r.sample_ids as string[] | null) ?? []).slice(0, EVIDENCE_LIMIT),
    });
    if (out.length >= MAX_CANDIDATES) return out;
  }

  return out;
}

/** Real transaction ids for one product inside the window, biggest first. */
async function evidenceFor(
  admin: Admin,
  userId: string,
  productId: string,
  windowStart: string,
  windowEnd: string,
): Promise<string[]> {
  const { data } = await admin
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('product_id', productId)
    .eq('direction', 'debit')
    .gte('occurred_at', `${windowStart}-01T00:00:00Z`)
    .lt('occurred_at', endExclusive(windowEnd))
    .order('amount', { ascending: false })
    .limit(EVIDENCE_LIMIT);
  return (data ?? []).map((r) => r.id as string);
}

/**
 * Sectors the coach must never suggest cutting. Suggesting someone stop paying
 * rent or skip medicine is the fastest way to destroy trust in the product.
 */
function isProtected(sectorSlug: string | null): boolean {
  if (!sectorSlug) return false;
  return ['housing', 'health', 'education', 'income', 'loans_transfers', 'uncategorized']
    .includes(sectorSlug);
}

function endExclusive(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1)); // m is 1-based, so this is next month
  return next.toISOString();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
