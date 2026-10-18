"use server";

import { revalidatePath } from "next/cache";
import { callFunction, describeEdgeError } from "@/lib/edge";
import type { IngestResult } from "@/lib/types";

/**
 * Statement upload.
 *
 * The file is forwarded to the `ingest` edge function as multipart/form-data.
 * It is NOT parsed here: the parser, the dedup key and the taxonomy resolver all
 * live in `supabase/functions/_shared` so that one implementation serves both
 * this upload path and any future one (a scheduled bank pull, a Telegram bot
 * receiving a PDF). Duplicating the parser in TypeScript here would be a second
 * copy of the trickiest logic in the system to keep in sync.
 *
 * The action is still the right place to validate cheaply — size and extension
 * are rejected before a 25 MB body crosses the network.
 */

export type UploadResult =
  | { ok: true; result: IngestResult }
  | { ok: false; error: string; notDeployed?: boolean };

/** Mirrors the storage bucket policy (migration 0005) and the ingest function. */
const MAX_BYTES = 25 * 1024 * 1024;

const ACCEPTED = new Set(["csv", "tsv", "txt", "xlsx", "xls", "pdf", "png", "jpg", "jpeg", "webp"]);

export async function uploadStatement(formData: FormData): Promise<UploadResult> {
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return { ok: false, error: "Choose a file to upload." };
  }
  if (file.size === 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB — split the statement by month and upload the parts separately.`,
    };
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ACCEPTED.has(ext)) {
    return {
      ok: false,
      error: `.${ext || "?"} files aren't supported yet. Use CSV, XLSX, PDF or an image of a statement.`,
    };
  }

  const accountId = String(formData.get("accountId") ?? "") || undefined;
  const hint = String(formData.get("hint") ?? "").trim() || undefined;

  const body = new FormData();
  body.set("file", file, file.name);
  if (accountId) body.set("accountId", accountId);
  if (hint) body.set("hint", hint);

  try {
    // Generous timeout: a 5,535-row CSV parses in seconds, but a scanned PDF
    // goes through the model page by page.
    const result = await callFunction<IngestResult>("ingest", {
      init: { method: "POST", body },
      timeoutMs: 300_000,
    });

    revalidatePath("/dashboard");
    revalidatePath("/transactions");
    revalidatePath("/documents");
    revalidatePath("/review");
    revalidatePath("/upload");

    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: describeEdgeError(err) };
  }
}

/**
 * Run the categorizer over whatever is still pending.
 *
 * Separate from upload because ingest deliberately leaves unresolved rows
 * pending rather than blocking the response on model calls. On a tracker export
 * that is ~0.02% of rows; on a bank PDF it is most of them.
 */
export async function categorizePending(options: {
  documentId?: string;
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<{ ok: true; categorized: number; message?: string } | { ok: false; error: string }> {
  try {
    const result = await callFunction<{ categorized?: number; skipped?: number; dryRun?: boolean }>(
      "categorize",
      { body: options, timeoutMs: 300_000 },
    );
    revalidatePath("/transactions");
    revalidatePath("/review");
    revalidatePath("/dashboard");
    return { ok: true, categorized: result.categorized ?? 0 };
  } catch (err) {
    return { ok: false, error: describeEdgeError(err) };
  }
}
