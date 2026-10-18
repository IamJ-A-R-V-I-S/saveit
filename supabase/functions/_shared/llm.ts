/**
 * LLM provider adapter.
 *
 * One interface, two implementations. Default is Gemini because it has a real
 * free tier, takes PDFs natively and has vision for OCR. OpenAI is there so the
 * user can swap models or keep a second key without touching call sites.
 *
 * Every call is metered against the user's daily cap in `profiles`. That matters
 * because this is a multi-tenant app on a free-tier key: one user must not be
 * able to burn everyone else's quota.
 */

import type { LlmUsage } from './types.ts';

export type Provider = 'gemini' | 'openai';

export interface CompleteOptions {
  /** Free-form system instruction. */
  system: string;
  /** The payload -- usually a compact JSON brief, never raw rows. */
  user: string;
  /** Force JSON output. Both providers support this natively. */
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  /** Inline file bytes (PDF/image). Gemini only. */
  inlineFile?: { mimeType: string; dataBase64: string };
}

export interface CompleteResult {
  text: string;
  usage: LlmUsage;
}

export class LlmError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

export class QuotaExceededError extends Error {
  constructor(public readonly used: number, public readonly cap: number) {
    super(`daily LLM quota exceeded (${used}/${cap} calls today)`);
    this.name = 'QuotaExceededError';
  }
}

// ---------------------------------------------------------------------------
// provider selection
// ---------------------------------------------------------------------------

/**
 * Which provider to use. Explicit request wins, then whichever key is present.
 * Gemini is preferred when both exist -- it is the free one.
 */
export function resolveProvider(preferred?: Provider | null): Provider {
  if (preferred === 'gemini' && Deno.env.get('GEMINI_API_KEY')) return 'gemini';
  if (preferred === 'openai' && Deno.env.get('OPENAI_API_KEY')) return 'openai';
  if (Deno.env.get('GEMINI_API_KEY')) return 'gemini';
  if (Deno.env.get('OPENAI_API_KEY')) return 'openai';
  throw new LlmError(
    'no LLM API key configured. Set GEMINI_API_KEY (or OPENAI_API_KEY) as a ' +
    'Supabase edge function secret.',
  );
}

const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.0-flash';
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
}

async function completeGemini(opts: CompleteOptions): Promise<CompleteResult> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new LlmError('GEMINI_API_KEY is not set');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const parts: Array<Record<string, unknown>> = [];
  if (opts.inlineFile) {
    parts.push({
      inline_data: {
        mime_type: opts.inlineFile.mimeType,
        data: opts.inlineFile.dataBase64,
      },
    });
  }
  parts.push({ text: opts.user });

  const body = {
    system_instruction: { parts: [{ text: opts.system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      // Native structured output -- far more reliable than asking for JSON in
      // the prompt and hoping.
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new LlmError(`Gemini ${res.status}: ${detail.slice(0, 400)}`, res.status);
  }

  const data = (await res.json()) as GeminiResponse;
  if (data.error?.message) throw new LlmError(`Gemini error: ${data.error.message}`);

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) {
    throw new LlmError(
      `Gemini returned an empty response (finishReason=${data.candidates?.[0]?.finishReason ?? 'unknown'})`,
    );
  }

  return {
    text,
    usage: {
      provider: 'gemini',
      model: GEMINI_MODEL,
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

async function completeOpenAi(opts: CompleteOptions): Promise<CompleteResult> {
  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) throw new LlmError('OPENAI_API_KEY is not set');

  // OpenAI has no single "inline file" slot the way Gemini does. A PDF has to
  // arrive as a data URL inside the content array; text goes alongside it.
  const content: Array<Record<string, unknown>> = [];
  if (opts.inlineFile) {
    content.push({
      type: 'file',
      file: {
        filename: 'statement',
        file_data: `data:${opts.inlineFile.mimeType};base64,${opts.inlineFile.dataBase64}`,
      },
    });
  }
  content.push({ type: 'text', text: opts.user });

  const body = {
    model: OPENAI_MODEL,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxOutputTokens ?? 4096,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content },
    ],
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new LlmError(`OpenAI ${res.status}: ${detail.slice(0, 400)}`, res.status);
  }

  const data = (await res.json()) as OpenAiResponse;
  if (data.error?.message) throw new LlmError(`OpenAI error: ${data.error.message}`);

  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) {
    throw new LlmError(
      `OpenAI returned an empty response (finish_reason=${data.choices?.[0]?.finish_reason ?? 'unknown'})`,
    );
  }

  return {
    text,
    usage: {
      provider: 'openai',
      model: OPENAI_MODEL,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

/**
 * Complete a prompt with metering.
 *
 * `recordUsage` is called after a successful request so the quota reflects real
 * calls, and so a provider failure does not silently eat the user's budget.
 */
export async function complete(
  opts: CompleteOptions,
  recordUsage?: (usage: LlmUsage, fn: string) => Promise<void> | void,
  fn = 'unknown',
): Promise<CompleteResult> {
  const provider = resolveProvider();
  const result = provider === 'gemini'
    ? await completeGemini(opts)
    : await completeOpenAi(opts);

  if (recordUsage) await recordUsage(result.usage, fn);
  return result;
}

/**
 * Complete and parse JSON, tolerating the two ways models wrap it even when
 * told not to: a ```json fence, and leading/trailing prose.
 */
export async function completeJson<T>(
  opts: Omit<CompleteOptions, 'json'>,
  recordUsage?: (usage: LlmUsage, fn: string) => Promise<void> | void,
  fn = 'unknown',
): Promise<{ data: T; usage: LlmUsage }> {
  const result = await complete({ ...opts, json: true }, recordUsage, fn);
  return { data: extractJson<T>(result.text), usage: result.usage };
}

export function extractJson<T>(raw: string): T {
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall back to the outermost brace/bracket pair.
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new LlmError(`could not parse JSON from model output: ${text.slice(0, 300)}`);
  }
}
