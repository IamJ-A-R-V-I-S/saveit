import type { Metadata } from "next";
import Link from "next/link";
import { PageHeading } from "@/components/page-heading";
import { Badge, Card, CardBody, CardHeader, EmptyState, KeyValue, cx, type Tone } from "@/components/ui";
import { getDocumentDownloadUrl, getDocuments } from "@/lib/data/documents";
import { count, dateLabel, num, relativeTime } from "@/lib/format";
import type { DocumentRow, DocumentStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Documents" };

const STATUS_TONE: Record<DocumentStatus, Tone> = {
  parsed: "success",
  uploaded: "info",
  parsing: "info",
  needs_review: "warning",
  failed: "danger",
};

const STATUS_LABEL: Record<DocumentStatus, string> = {
  parsed: "imported",
  uploaded: "queued",
  parsing: "parsing",
  needs_review: "needs review",
  failed: "failed",
};

/**
 * Uploaded statements.
 *
 * The column that matters most is duplicates: it is the visible proof that
 * re-uploading an overlapping statement is safe. Without it, "imported 4,000 of
 * 5,535 rows" reads like a failure rather than 1,535 rows you already had.
 */
export default async function DocumentsPage() {
  const documents = await getDocuments(100);

  // Signed URLs are resolved up front rather than inside the render. Mapping to
  // an async callback would hand React an array of Promises, which is not
  // something to rely on for a list; awaiting here is unambiguous and runs the
  // storage calls concurrently.
  const withUrls = await Promise.all(
    documents.map(async (doc) => ({
      doc,
      downloadUrl: await getDocumentDownloadUrl(doc),
    })),
  );

  const totals = documents.reduce(
    (acc, d) => ({
      rows: acc.rows + (d.row_count ?? 0),
      imported: acc.imported + (d.imported_count ?? 0),
      duplicates: acc.duplicates + (d.duplicate_count ?? 0),
    }),
    { rows: 0, imported: 0, duplicates: 0 },
  );

  return (
    <>
      <PageHeading
        title="Documents"
        sub="Every statement you've uploaded, what it yielded, and how much of it was already in your ledger."
        action={
          <Link
            href="/upload"
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            ⇪ Upload another
          </Link>
        }
      />

      {documents.length === 0 ? (
        <Card className="mt-6">
          <EmptyState
            icon={<span className="text-3xl">▤</span>}
            title="Nothing uploaded yet"
            body="Your first statement is the whole setup: the parser reads its layout, the taxonomy seeds itself, and the dashboard fills in."
            action={
              <Link
                href="/upload"
                className="inline-block rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90"
              >
                Upload a statement
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-4">
            <MiniStat label="Files" value={count(documents.length)} />
            <MiniStat label="Rows read" value={count(totals.rows)} />
            <MiniStat label="Imported" value={count(totals.imported)} />
            <MiniStat
              label="Duplicates skipped"
              value={count(totals.duplicates)}
              hint="already in your ledger"
            />
          </div>

          <ul className="mt-5 space-y-3">
            {withUrls.map(({ doc, downloadUrl }) => (
              <DocumentCard key={doc.id} doc={doc} downloadUrl={downloadUrl} />
            ))}
          </ul>
        </>
      )}

      <Card className="mt-6">
        <CardBody className="text-xs leading-relaxed text-muted">
          <p className="font-semibold text-ink">Total across every upload</p>
          <p className="mt-1.5">
            {count(totals.imported)} transactions imported from {count(totals.rows)} rows read, with{" "}
            {count(totals.duplicates)} skipped as duplicates of an earlier upload. Files are stored
            privately in Supabase Storage — the bucket is not public and the download links above
            are signed and expire after ten minutes.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

function DocumentCard({
  doc,
  downloadUrl,
}: {
  doc: DocumentRow;
  downloadUrl: string | null;
}) {
  const coverage = doc.coverage ?? {};
  const resolvedFree = num(coverage.resolvedFree);
  const needsLlm = num(coverage.needsLlm);
  const total = resolvedFree + needsLlm;
  const pctFree = total > 0 ? (resolvedFree / total) * 100 : null;

  return (
    <li className="list-none">
      <Card>
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate font-mono text-sm">{doc.filename}</span>
              <Badge tone={STATUS_TONE[doc.status] ?? "neutral"}>
                {STATUS_LABEL[doc.status] ?? doc.status}
              </Badge>
              <Badge>{doc.kind.toUpperCase()}</Badge>
              {doc.source_type ? <Badge tone="info">{doc.source_type}</Badge> : null}
            </span>
          }
          hint={
            <>
              Uploaded {relativeTime(doc.created_at)} ·{" "}
              {doc.period_start
                ? `covers ${dateLabel(doc.period_start)} – ${dateLabel(doc.period_end)}`
                : "no date range detected"}
              {doc.size_bytes ? ` · ${(Number(doc.size_bytes) / 1024).toFixed(0)} KB` : ""}
            </>
          }
          action={
            downloadUrl ? (
              <a
                href={downloadUrl}
                download
                className="rounded-md border border-line-strong px-2.5 py-1 text-[11px] font-semibold hover:bg-sunken"
              >
                Download
              </a>
            ) : null
          }
        />

        {doc.error_message ? (
          <div
            className={cx(
              "border-t px-5 py-2.5 text-xs leading-relaxed",
              doc.status === "failed"
                ? "border-danger/25 bg-danger-soft text-danger"
                : "border-warning/25 bg-warning-soft text-warning",
            )}
          >
            {doc.error_message}
          </div>
        ) : null}

        <CardBody>
          <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
            <KeyValue label="Rows read">{count(doc.row_count ?? 0)}</KeyValue>
            <KeyValue label="Imported">{count(doc.imported_count ?? 0)}</KeyValue>
            <KeyValue label="Duplicates">{count(doc.duplicate_count ?? 0)}</KeyValue>
            <KeyValue label="Resolved free">
              {pctFree === null ? "—" : `${pctFree.toFixed(1)}%`}
            </KeyValue>
          </dl>

          {(doc.imported_count ?? 0) > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-[11px] text-muted">
              {doc.period_start ? (
                <Link
                  href={`/transactions?month=${doc.period_start}`}
                  className="font-semibold text-accent hover:underline"
                >
                  View its transactions →
                </Link>
              ) : null}
              {needsLlm > 0 ? (
                <span className="text-faint">
                  {count(needsLlm)} row{needsLlm === 1 ? "" : "s"} needed a model call
                </span>
              ) : (
                <span className="text-faint">no model calls needed</span>
              )}
            </div>
          ) : null}
        </CardBody>
      </Card>
    </li>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className="tnum mt-1 text-xl font-semibold">{value}</p>
      {hint ? <p className="text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}
