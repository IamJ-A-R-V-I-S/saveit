"use client";

import { useState, useTransition } from "react";
import { Badge, cx } from "@/components/ui";
import { checkBackend, type ProbeResult } from "@/lib/actions/system";

/** Runs the backend probe on demand and shows what came back. */
export function BackendStatus({ initialBaseUrl }: { initialBaseUrl: string }) {
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [seconds, setSeconds] = useState(0);
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const outcome = await checkBackend();
      setResults(outcome.results);
      setBaseUrl(outcome.baseUrl);
      setSeconds(outcome.seconds);
    });
  }

  const deployed = results?.filter((r) => r.deployed).length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="rounded-lg border border-line-strong px-3.5 py-2 text-xs font-semibold text-ink hover:bg-sunken disabled:opacity-50"
        >
          {pending ? "Checking…" : results ? "Check again" : "Check the backend"}
        </button>

        {results ? (
          <span className="text-xs text-muted">
            <strong className={cx("font-semibold", deployed === results.length ? "text-success" : "text-warning")}>
              {deployed} of {results.length}
            </strong>{" "}
            deployed · {seconds.toFixed(1)}s
          </span>
        ) : (
          <span className="text-xs text-muted">Not checked yet.</span>
        )}
      </div>

      <p className="font-mono text-[11px] break-all text-faint">{baseUrl}</p>

      {results ? (
        <ul className="space-y-1.5">
          {results.map((r) => (
            <li
              key={r.slug}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
            >
              <span className="min-w-0">
                <span className="font-mono text-xs font-semibold text-ink">{r.slug}</span>
                <span className="ml-2 text-[11px] text-muted">{r.purpose}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {r.status !== null ? (
                  <span className="tnum text-[11px] text-faint">HTTP {r.status}</span>
                ) : null}
                <Badge tone={r.deployed ? "success" : "danger"}>
                  {r.deployed ? "deployed" : "missing"}
                </Badge>
              </span>
              <span className="w-full text-[11px] text-faint">{r.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {results && deployed < results.length ? (
        <div className="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-warning">
          <p className="font-semibold">Deploy the missing functions</p>
          <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] text-ink">
{`supabase functions deploy ingest
supabase functions deploy categorize
supabase functions deploy coach
supabase functions deploy coach-cron
supabase functions deploy notify
supabase functions deploy correct`}
          </pre>
          <p className="mt-1.5">
            Then set the secrets: <code className="font-mono">GEMINI_API_KEY</code>,{" "}
            <code className="font-mono">CRON_SECRET</code>,{" "}
            <code className="font-mono">TELEGRAM_BOT_TOKEN</code>.
          </p>
        </div>
      ) : null}
    </div>
  );
}
