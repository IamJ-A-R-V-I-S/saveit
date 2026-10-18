"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { cx } from "@/components/ui";

/**
 * Transaction filters.
 *
 * State lives in the URL, not in the component. Three reasons: a filtered view
 * is shareable and survives a refresh; the back button works; and the Server
 * Component that runs the query reads the same params, so there is exactly one
 * source of truth about what is being looked at.
 *
 * The text search is debounced and written with `router.replace` so typing does
 * not push fifty history entries.
 */

export interface FilterOptions {
  months: { value: string; label: string }[];
  sectors: { slug: string; name: string; icon: string | null }[];
  accounts: { id: string; name: string }[];
}

const SORTS = [
  { value: "date_desc", label: "Newest" },
  { value: "date_asc", label: "Oldest" },
  { value: "amount_desc", label: "Largest" },
  { value: "amount_asc", label: "Smallest" },
] as const;

export function FilterBar({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const urlQuery = params.get("q") ?? "";
  const [search, setSearch] = useState(urlQuery);
  const [lastUrlQuery, setLastUrlQuery] = useState(urlQuery);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * Resync the box when the URL changes underneath it — back button, or a link
   * from the dashboard that pre-fills a sector and month.
   *
   * Done during render rather than in an effect. This is the "adjusting state
   * when a prop changes" pattern from the React docs: React re-renders
   * immediately without committing the stale output, so there is no extra paint.
   * An effect would render the old value first, then correct it, which shows up
   * as a visible flicker in the search box on every back-navigation.
   */
  if (urlQuery !== lastUrlQuery) {
    setLastUrlQuery(urlQuery);
    setSearch(urlQuery);
  }

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (!value) next.delete(key);
      else next.set(key, value);
      // Changing a filter resets you to the first page; staying on page 7 of a
      // now-shorter result set shows an empty table and looks broken.
      next.delete("page");
      startTransition(() => {
        router.replace(`?${next.toString()}`, { scroll: false });
      });
    },
    [params, router],
  );

  const onSearchChange = (value: string) => {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam("q", value.trim() || null), 300);
  };

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  const activeCount = ["month", "sector", "account", "product", "status", "dir", "q"].filter(
    (k) => params.get(k),
  ).length;

  return (
    <div className="card px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-45 flex-1">
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search description, note or payee…"
            aria-label="Search transactions"
            className="field pr-8"
          />
          {search ? (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-faint hover:text-ink"
            >
              ✕
            </button>
          ) : null}
        </div>

        <Select
          label="Month"
          value={params.get("month") ?? ""}
          onChange={(v) => setParam("month", v || null)}
          options={[{ value: "", label: "All months" }, ...options.months]}
        />

        <Select
          label="Sector"
          value={params.get("sector") ?? ""}
          onChange={(v) => setParam("sector", v || null)}
          options={[
            { value: "", label: "All sectors" },
            ...options.sectors.map((s) => ({
              value: s.slug,
              label: `${s.icon ? `${s.icon} ` : ""}${s.name}`,
            })),
          ]}
        />

        <Select
          label="Account"
          value={params.get("account") ?? ""}
          onChange={(v) => setParam("account", v || null)}
          options={[
            { value: "", label: "All accounts" },
            ...options.accounts.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />

        <Select
          label="Direction"
          value={params.get("dir") ?? ""}
          onChange={(v) => setParam("dir", v || null)}
          options={[
            { value: "", label: "Spend + income" },
            { value: "debit", label: "Spend only" },
            { value: "credit", label: "Income only" },
          ]}
        />

        <Select
          label="Status"
          value={params.get("status") ?? ""}
          onChange={(v) => setParam("status", v || null)}
          options={[
            { value: "", label: "Any status" },
            { value: "auto", label: "Auto-categorized" },
            { value: "corrected", label: "Corrected" },
            { value: "review", label: "Needs review" },
            { value: "pending", label: "Pending" },
          ]}
        />

        <Select
          label="Sort"
          value={params.get("sort") ?? "date_desc"}
          onChange={(v) => setParam("sort", v === "date_desc" ? null : v)}
          options={[...SORTS]}
        />

        {activeCount > 0 ? (
          <button
            type="button"
            onClick={() => {
              startTransition(() => router.replace("?", { scroll: false }));
              setSearch("");
            }}
            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-sunken hover:text-ink"
          >
            Clear ({activeCount})
          </button>
        ) : null}
      </div>

      {pending ? (
        // A hairline at the bottom of the bar. Subtle because filters change
        // often and a full skeleton would flash on every keystroke.
        <div className="progress-indeterminate relative mt-3 h-0.5 overflow-hidden rounded-full bg-sunken" />
      ) : null}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx("field w-auto min-w-32 appearance-none pr-7 text-xs", value && "font-semibold text-ink")}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[10px] text-faint" aria-hidden>
        ▾
      </span>
    </label>
  );
}
