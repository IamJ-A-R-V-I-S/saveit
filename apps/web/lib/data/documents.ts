import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DocumentRow } from "@/lib/types";

/**
 * Uploaded statements.
 *
 * A document row exists BEFORE parsing finishes (ingest inserts it first so the
 * storage path can contain its id), which is why `status` has intermediate
 * values. That matters for the UI: an upload that died mid-parse leaves a
 * `parsing` row behind, and showing it as "in progress" forever would be a lie.
 */
export async function getDocuments(limit = 50): Promise<DocumentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getDocuments:", error.message);
    return [];
  }
  return (data as DocumentRow[]) ?? [];
}

export async function getDocument(id: string): Promise<DocumentRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("getDocument:", error.message);
    return null;
  }
  return (data as DocumentRow | null) ?? null;
}

/** A signed URL so the user can re-download what they uploaded. */
export async function getDocumentDownloadUrl(doc: DocumentRow): Promise<string | null> {
  if (!doc.storage_path) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from("statements")
    .createSignedUrl(doc.storage_path, 60 * 10);

  if (error) {
    console.error("getDocumentDownloadUrl:", error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

/**
 * Whether a file with this hash was already imported.
 *
 * The dedup key makes re-uploading safe at the transaction level, but telling
 * the user "you already uploaded this exact file" before spending 30 seconds
 * parsing it is a better experience. `sha256` is written by ingest.
 */
export async function findDocumentByHash(hash: string): Promise<DocumentRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("sha256", hash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return (data as DocumentRow | null) ?? null;
}
