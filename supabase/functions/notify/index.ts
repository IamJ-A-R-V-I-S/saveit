/**
 * POST /functions/v1/notify
 *
 *   {"userId": "...", "insights": [...]}   send the coach result to Telegram
 *   {"test": true}                         send a test message to the caller
 *
 * Telegram was chosen over email/WhatsApp because it needs no approval process
 * and no paid provider: a bot token plus a chat id, both free, both instant.
 *
 * The chat id lives on the profile rather than in an env var because this is a
 * multi-tenant app -- each user gets their own.
 */

import {
  corsHeaders, fail, json, serviceClient, userIdFromRequest,
} from '../_shared/db.ts';

interface InsightPayload {
  rank?: number;
  headline?: string;
  detail?: string;
  monthlySavingEstimate?: number | null;
  confidence?: number;
  sector?: string | null;
  product?: string | null;
  txCount?: number;
  spend?: number;
  evidenceCount?: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('use POST', 405);

  const admin = serviceClient();
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return fail('TELEGRAM_BOT_TOKEN is not configured', 501);

  try {
    const body = (await req.json().catch(() => ({}))) as {
      userId?: string;
      insights?: InsightPayload[];
      message?: string;
      test?: boolean;
      window?: { start?: string; end?: string };
    };

    const callerId = await userIdFromRequest(req, admin);
    const userId = body.userId ?? callerId;
    if (!userId) return fail('unauthenticated', 401);

    // Only the user themselves, or an internal call carrying the service role
    // (which has no Authorization header from a browser), may target a user.
    if (callerId && callerId !== userId) return fail('cannot notify another user', 403);

    const { data: profile, error } = await admin
      .from('profiles')
      .select('telegram_chat_id, telegram_enabled, full_name')
      .eq('id', userId)
      .maybeSingle();
    if (error) return fail(`profile lookup failed: ${error.message}`, 500);

    if (!profile?.telegram_chat_id) {
      return fail('no telegram_chat_id on this profile', 412, {
        howToFix: 'Message your bot once, then call GET /functions/v1/notify/webhook-setup ' +
          'or set telegram_chat_id on your profile.',
      });
    }

    const text = body.test
      ? `✅ SaveIt notifications are working${profile.full_name ? `, ${profile.full_name}` : ''}.`
      : body.message
        ? body.message
        : formatInsights(body.insights ?? [], body.window, profile.full_name);

    if (!text) return json({ sent: false, reason: 'nothing to send' });

    const sent = await sendTelegram(token, profile.telegram_chat_id, text);
    if (!sent.ok) return fail(`telegram send failed: ${sent.error}`, 502);

    // Turning the flag on implicitly: a successful send proves the chat id works.
    if (!profile.telegram_enabled) {
      await admin.from('profiles').update({ telegram_enabled: true }).eq('id', userId);
    }

    return json({ sent: true, messageId: sent.messageId, chatId: profile.telegram_chat_id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('notify failed:', msg);
    return fail(msg, 500);
  }
});

// ---------------------------------------------------------------------------

function inr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
}

/**
 * Format the coach result as a Telegram message.
 *
 * HTML parse mode, not Markdown: Telegram's Markdown parser chokes on
 * unbalanced brackets and rupee-adjacent punctuation, and a formatting error
 * silently drops the whole message.
 */
function formatInsights(
  insights: InsightPayload[],
  window?: { start?: string; end?: string },
  name?: string | null,
): string {
  if (insights.length === 0) return '';

  const lines: string[] = [];
  lines.push('<b>💡 SaveIt coach</b>');
  if (window?.start && window?.end) {
    lines.push(`<i>${window.start} → ${window.end}</i>`);
  }
  lines.push('');

  const total = insights.reduce((s, i) => s + (i.monthlySavingEstimate ?? 0), 0);
  if (total > 0) {
    lines.push(`<b>${inr(total)}/month</b> of potential savings found:`);
    lines.push('');
  }

  for (const i of insights.slice(0, 5)) {
    const rank = i.rank ?? insights.indexOf(i) + 1;
    lines.push(`<b>${rank}. ${escapeHtml(i.headline ?? 'Opportunity')}</b>`);
    if (i.detail) lines.push(escapeHtml(i.detail));
    const bits: string[] = [];
    if (i.monthlySavingEstimate) bits.push(`save ~${inr(i.monthlySavingEstimate)}/mo`);
    if (i.txCount) bits.push(`${i.txCount} txns`);
    if (i.spend) bits.push(`${inr(i.spend)} total`);
    if (bits.length) lines.push(`<i>${bits.join(' · ')}</i>`);
    lines.push('');
  }

  lines.push('Open SaveIt for the transactions behind each one.');
  if (name) lines.push(`— for ${escapeHtml(name)}`);

  return lines.join('\n').trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface SendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const data = await res.json().catch(() => ({})) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };

    if (!res.ok || !data.ok) {
      return { ok: false, error: data.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
