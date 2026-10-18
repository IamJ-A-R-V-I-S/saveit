import { count, money, moneyCompact, monthLabel, num, shortMonth } from "@/lib/format";
import { cx } from "@/components/ui";

/**
 * Charts, hand-rolled as SVG and divs.
 *
 * No charting library. Three reasons, in order of importance:
 *
 *  1. Hydration. A chart library renders on the server and again on the client,
 *     and any nondeterminism (a resize observer, a random id, `Date.now()` in a
 *     tooltip) produces a mismatch warning that is easy to introduce and easy to
 *     miss.
 *  2. These are three charts: a monthly bar series, a ranked horizontal bar
 *     list, and a progress bar. That is less code than configuring a library.
 *  3. Bundle. Recharts would add ~100 KB gzipped to a page whose whole job is
 *     to load fast after a navigation.
 *
 * Everything here is a Server Component, so the initial HTML already contains
 * the rendered chart — no spinner, no client round trip.
 */

/* ------------------------------------------------- monthly spend trend ---- */

export interface TrendPoint {
  month: string;
  spend: number;
  income: number;
  txCount: number;
  /** Rows in the month. Low counts mean the month is sparse, not cheap. */
  sparse?: boolean;
}

/**
 * Spend and income per month.
 *
 * Sparse months are hatched rather than drawn normally. This is the honesty
 * rule from the design: statements arrive partial (the sample data has months
 * with 14 transactions and months with 267), and a month that looks like a dip
 * because the user only uploaded two weeks of it must not read as "you saved
 * money".
 */
export function MonthTrend({
  points,
  height = 180,
}: {
  points: TrendPoint[];
  height?: number;
}) {
  if (points.length === 0) return null;

  const max = Math.max(1, ...points.map((p) => Math.max(p.spend, p.income)));
  const gap = 6;
  const barWidth = Math.max(6, Math.min(34, Math.floor(560 / points.length) - gap));
  const groupWidth = barWidth * 2 + gap;
  const width = points.length * (groupWidth + gap * 2);
  const labelEvery = points.length > 8 ? Math.ceil(points.length / 8) : 1;

  return (
    <div className="w-full overflow-x-auto pb-1">
      <svg
        viewBox={`0 0 ${width} ${height + 34}`}
        width={width}
        height={height + 34}
        role="img"
        aria-label={`Monthly spend and income. Highest month ${money(max)}.`}
        className="max-w-none"
      >
        {/* gridline at the peak so the bars have something to be read against */}
        <line
          x1={0}
          x2={width}
          y1={2}
          y2={2}
          stroke="var(--border)"
          strokeDasharray="3 4"
          strokeWidth={1}
        />
        <text x={0} y={0} fontSize={10} fill="var(--faint)" className="tnum" dominantBaseline="hanging">
          {moneyCompact(max)}
        </text>

        {points.map((p, i) => {
          const x = i * (groupWidth + gap * 2) + gap;
          const spendH = Math.round((p.spend / max) * (height - 12));
          const incomeH = Math.round((p.income / max) * (height - 12));
          const baseline = height - 4;

          return (
            <g key={p.month}>
              <title>
                {`${monthLabel(p.month)} — spend ${money(p.spend)}, income ${money(p.income)}, ${count(p.txCount)} transactions${p.sparse ? " (sparse data)" : ""}`}
              </title>

              {/* income: drawn behind, emerald, only as tall as it needs to be */}
              <rect
                x={x + barWidth + gap / 2}
                y={baseline - incomeH}
                width={barWidth}
                height={Math.max(incomeH, p.income > 0 ? 2 : 0)}
                rx={2}
                fill="var(--income)"
                opacity={p.sparse ? 0.4 : 0.75}
              />

              {/* spend: foreground, rose. Hatched when the month is sparse. */}
              <rect
                x={x}
                y={baseline - spendH}
                width={barWidth}
                height={Math.max(spendH, p.spend > 0 ? 2 : 0)}
                rx={2}
                fill={p.sparse ? "url(#sparse-hatch)" : "var(--spend)"}
                opacity={p.sparse ? 0.85 : 0.9}
              />

              {i % labelEvery === 0 ? (
                <text
                  x={x + groupWidth / 2}
                  y={height + 10}
                  fontSize={10}
                  fill="var(--muted)"
                  textAnchor="middle"
                >
                  {shortMonth(p.month)}
                </text>
              ) : null}
            </g>
          );
        })}

        <defs>
          <pattern id="sparse-hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="5" height="5" fill="var(--spend-soft)" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--spend)" strokeWidth="1.6" />
          </pattern>
        </defs>
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <Legend swatch="var(--spend)" label="Spend" />
        <Legend swatch="var(--income)" label="Income" />
        <Legend swatch="url(#sparse-hatch)" label="Sparse month — data may be incomplete" hatch />
      </div>
    </div>
  );
}

function Legend({
  swatch,
  label,
  hatch,
}: {
  swatch: string;
  label: string;
  hatch?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {hatch ? (
        <span
          className="inline-block size-2.5 rounded-[2px] border"
          style={{
            borderColor: "var(--spend)",
            backgroundImage:
              "repeating-linear-gradient(45deg, var(--spend) 0 1.5px, var(--spend-soft) 1.5px 4px)",
          }}
        />
      ) : (
        <span className="inline-block size-2.5 rounded-[2px]" style={{ background: swatch }} />
      )}
      {label}
    </span>
  );
}

/* ------------------------------------------------- ranked horizontal bar -- */

export interface RankedBar {
  id: string;
  label: string;
  value: number;
  /** Right-hand annotation, e.g. "785 × ₹8". */
  meta?: string;
  icon?: string | null;
  href?: string;
}

/**
 * A ranked list as bars. Used for sector breakdown and top products.
 *
 * Rendered with divs rather than SVG because the labels are real text that must
 * wrap, truncate and stay selectable — and because a `<a>` around a row is
 * trivial here and awkward inside an SVG.
 */
export function RankedBars({
  rows,
  tone = "spend",
  emptyLabel = "Nothing to show yet",
}: {
  rows: RankedBar[];
  tone?: "spend" | "accent" | "info";
  emptyLabel?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">{emptyLabel}</p>;
  }

  const max = Math.max(1, ...rows.map((r) => r.value));
  const fill = tone === "accent" ? "bg-accent" : tone === "info" ? "bg-info" : "bg-spend";

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.id}>
          {row.href ? (
            <a href={row.href} className="group block">
              <BarRow row={row} max={max} fill={fill} />
            </a>
          ) : (
            <BarRow row={row} max={max} fill={fill} />
          )}
        </li>
      ))}
    </ul>
  );
}

function BarRow({ row, max, fill }: { row: RankedBar; max: number; fill: string }) {
  const pct = Math.max(1.5, (row.value / max) * 100);
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink">
          {row.icon ? (
            <span className="shrink-0 text-xs" aria-hidden>
              {row.icon}
            </span>
          ) : null}
          <span className="truncate group-hover:underline">{row.label}</span>
        </span>
        <span className="tnum shrink-0 text-sm font-medium text-ink">
          {money(row.value)}
          {row.meta ? <span className="ml-1.5 text-xs font-normal text-muted">{row.meta}</span> : null}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
        <div className={cx("h-full rounded-full", fill)} style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}

/* -------------------------------------------------------- inline sparkbar -- */

/** A tiny proportion bar for use inside a table cell. */
export function CellBar({
  value,
  max,
  tone = "spend",
}: {
  value: unknown;
  max: number;
  tone?: "spend" | "accent";
}) {
  const v = num(value);
  const pct = max > 0 ? Math.max(1, (v / max) * 100) : 0;
  return (
    <span className="block h-1 w-full min-w-12 overflow-hidden rounded-full bg-sunken">
      <span
        className={cx("block h-full rounded-full", tone === "accent" ? "bg-accent" : "bg-spend")}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
