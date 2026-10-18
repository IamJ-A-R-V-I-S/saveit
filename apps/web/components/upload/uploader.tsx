"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { uploadStatement } from "@/lib/actions/upload";
import { Badge, Card, CardBody, cx } from "@/components/ui";
import { count, dateLabel } from "@/lib/format";
import type { IngestResult } from "@/lib/types";

/**
 * Statement uploader.
 *
 * Drag-and-drop plus a normal file input, posting to the `uploadStatement`
 * Server Action. The action forwards the file to the `ingest` edge function;
 * nothing is parsed in the browser, so the parser exists in exactly one place.
 *
 * The result panel is deliberately detailed. "Imported" alone would hide the
 * two numbers that matter most for trusting the system: how many rows were
 * duplicates of an earlier upload (proving re-upload is safe), and how many
 * needed a model call (proving the deterministic resolver did the work).
 */

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = ".csv,.tsv,.txt,.xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp";

type Phase = "idle" | "uploading" | "done" | "error";

export function Uploader({
  accounts,
}: {
  accounts: { id: string; name: string }[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, startTransition] = useTransition();

  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const choose = useCallback((incoming: File | null | undefined) => {
    if (!incoming) return;
    if (incoming.size > MAX_BYTES) {
      setPhase("error");
      setError(
        `That file is ${(incoming.size / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB — split it by month and upload the parts.`,
      );
      return;
    }
    setFile(incoming);
    setError(null);
    setResult(null);
    setPhase("idle");
  }, []);

  async function submit(formData: FormData) {
    if (!file) return;
    setPhase("uploading");
    setError(null);
    setResult(null);

    const body = new FormData();
    body.set("file", file, file.name);
    const accountId = String(formData.get("accountId") ?? "");
    const hint = String(formData.get("hint") ?? "").trim();
    if (accountId) body.set("accountId", accountId);
    if (hint) body.set("hint", hint);

    // `startTransition` keeps the page responsive during a long upload and lets
    // Next show its pending state; the await inside is what we branch on.
    startTransition(async () => {
      const outcome = await uploadStatement(body);
      if (outcome.ok) {
        setResult(outcome.result);
        setPhase("done");
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
      } else {
        setError(outcome.error);
        setPhase("error");
      }
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card>
          <CardBody>
            <form action={submit} className="space-y-4">
              <div
                ref={dropRef}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  choose(e.dataTransfer.files?.[0]);
                }}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    inputRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="Choose a statement file"
                className={cx(
                  "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
                  dragging ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent hover:bg-sunken",
                )}
              >
                <input
                  ref={inputRef}
                  type="file"
                  name="file"
                  accept={ACCEPT}
                  className="sr-only"
                  onChange={(e) => choose(e.target.files?.[0])}
                />
                <span className="text-3xl" aria-hidden>
                  ⇪
                </span>
                <p className="mt-3 text-sm font-semibold text-ink">
                  {file ? file.name : "Drop a statement here, or click to choose"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {file
                    ? `${(file.size / 1024).toFixed(0)} KB — ready to upload`
                    : "CSV, XLSX, PDF, or a photo of a paper statement · up to 25 MB"}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="accountId">
                    Account <span className="font-normal text-faint">(optional)</span>
                  </label>
                  <select id="accountId" name="accountId" className="field" defaultValue="">
                    <option value="">Detect from the file</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                    Most statements name their own account. Only set this if the file doesn&apos;t.
                  </p>
                </div>

                <div>
                  <label className="label" htmlFor="hint">
                    Hint <span className="font-normal text-faint">(optional)</span>
                  </label>
                  <input
                    id="hint"
                    name="hint"
                    type="text"
                    className="field"
                    placeholder="e.g. columns are date, note, amount"
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                    Helps with an unusual layout or a scanned PDF.
                  </p>
                </div>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-xs leading-relaxed whitespace-pre-line text-danger"
                >
                  {error}
                </p>
              ) : null}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={!file || phase === "uploading"}
                  className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {phase === "uploading" ? "Parsing…" : "Upload and categorize"}
                </button>

                {phase === "uploading" ? (
                  <span className="text-xs text-muted">
                    A large CSV takes a few seconds; a scanned PDF takes longer.
                  </span>
                ) : null}
              </div>

              {phase === "uploading" ? (
                // Indeterminate on purpose: there is no meaningful progress
                // signal from the function, and a fake percentage that stalls is
                // worse than an honest bar.
                <div className="progress-indeterminate relative h-1 w-full overflow-hidden rounded-full bg-sunken" />
              ) : null}
            </form>
          </CardBody>
        </Card>

        {result ? <IngestReport result={result} /> : null}
      </div>

      <div className="space-y-4">
        <Card>
          <CardBody className="space-y-3">
            <h2 className="text-sm font-semibold">What happens next</h2>
            <ol className="space-y-2.5 text-xs leading-relaxed text-muted">
              <Step n={1} title="Parse">
                Delimiter, header row and column roles are detected from the file itself — the same
                parser handles <code className="font-mono text-[11px]">;</code> and{" "}
                <code className="font-mono text-[11px]">,</code>, and both date orders.
              </Step>
              <Step n={2} title="Deduplicate">
                Each row gets a hash of account, second, amount and description. Re-upload an
                overlapping statement and nothing is counted twice.
              </Step>
              <Step n={3} title="Categorize">
                Exact match, then your aliases, then keyword priors. Only what none of those can
                place reaches a model.
              </Step>
              <Step n={4} title="Review">
                Anything ambiguous lands in the review queue instead of being guessed at. Correcting
                one row teaches every future row like it.
              </Step>
            </ol>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="text-xs leading-relaxed text-muted">
            <p className="font-semibold text-ink">Already uploaded this?</p>
            <p className="mt-1.5">
              It&apos;s safe. The dedup key makes an overlapping import a no-op, and{" "}
              <Link href="/documents" className="font-semibold text-accent hover:underline">
                Documents
              </Link>{" "}
              will show the duplicate count.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="tnum mt-px flex size-4.5 shrink-0 items-center justify-center rounded-full bg-sunken text-[10px] font-bold text-muted">
        {n}
      </span>
      <span>
        <span className="font-semibold text-ink">{title}.</span> {children}
      </span>
    </li>
  );
}

function IngestReport({ result }: { result: IngestResult }) {
  const pctFree =
    result.rowCount > 0 ? (result.resolvedWithoutLlm / result.rowCount) * 100 : 0;

  return (
    <Card className="mt-4 border-success/30">
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base" aria-hidden>
            ✓
          </span>
          <h2 className="text-sm font-semibold text-ink">
            Imported {count(result.inserted)} of {count(result.rowCount)} rows
          </h2>
          <Badge tone="success">{result.kind.toUpperCase()}</Badge>
          {result.sourceType ? <Badge tone="info">{result.sourceType}</Badge> : null}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <ReportStat label="New transactions" value={count(result.inserted)} />
          <ReportStat
            label="Duplicates skipped"
            value={count(result.duplicates)}
            hint={result.duplicates > 0 ? "seen in an earlier upload" : undefined}
          />
          <ReportStat
            label="Resolved free"
            value={`${pctFree.toFixed(1)}%`}
            hint={`${count(result.resolvedWithoutLlm)} rows, no model call`}
            tone={pctFree >= 90 ? "success" : pctFree >= 50 ? "warning" : "danger"}
          />
          <ReportStat
            label="Model calls"
            value={count(result.llmCallsUsed)}
            hint={result.llmCallsUsed === 0 ? "none needed" : undefined}
          />
        </dl>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {result.needsReview > 0 ? (
            <Link href="/review">
              <Badge tone="warning" className="cursor-pointer hover:opacity-80">
                {count(result.needsReview)} need your review →
              </Badge>
            </Link>
          ) : (
            <Badge tone="success">nothing needs review</Badge>
          )}

          {result.pendingCategorization > 0 ? (
            <Badge tone="info">{count(result.pendingCategorization)} queued for the model</Badge>
          ) : null}

          {result.taxonomySeeded ? (
            <Badge tone="neutral">seeded {count(result.productsSeeded)} products</Badge>
          ) : null}

          <span className="tnum text-[11px] text-faint">
            covering {dateLabel(result.period.start)} – {dateLabel(result.period.end)}
          </span>
        </div>

        {result.skipped && result.skipped > 0 ? (
          <p className="rounded-lg bg-sunken px-3 py-2 text-[11px] leading-relaxed text-muted">
            {count(result.skipped)} row{result.skipped === 1 ? "" : "s"} skipped — usually a total,
            a balance line or a row with no readable amount.
            {result.skippedSamples && result.skippedSamples.length > 0 ? (
              <>
                {" "}
                Examples:{" "}
                <span className="font-mono">
                  {result.skippedSamples.slice(0, 3).map((s) => `“${s}”`).join(", ")}
                </span>
              </>
            ) : null}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Link
            href="/dashboard"
            className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-ink hover:opacity-90"
          >
            Go to dashboard
          </Link>
          <Link
            href="/transactions"
            className="rounded-lg border border-line-strong px-3.5 py-1.5 text-xs font-semibold text-ink hover:bg-sunken"
          >
            Browse transactions
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

function ReportStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "success" | "warning" | "danger";
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</dt>
      <dd
        className={cx(
          "tnum mt-0.5 text-lg font-semibold",
          tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
      </dd>
      {hint ? <dd className="text-[11px] text-faint">{hint}</dd> : null}
    </div>
  );
}
