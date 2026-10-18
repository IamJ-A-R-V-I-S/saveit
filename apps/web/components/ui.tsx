import type { ReactNode } from "react";
import { money, moneyCompact, num, type Tone } from "@/lib/format";

// Re-exported so components can type a `tone` prop without importing from two
// places. `Tone` is defined in lib/format because confidenceLabel produces one.
export type { Tone };

/**
 * Presentational primitives.
 *
 * Everything here is a Server Component: no event handlers, no state. Anything
 * that mutates lives in components/actions so the boundary between "renders
 * data" and "changes data" is a directory, not a convention you have to
 * remember.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------------------------------------------- card ---- */

export function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return <Tag className={cx("card", className)}>{children}</Tag>;
}

export function CardHeader({
  title,
  hint,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("px-5 py-4", className)}>{children}</div>;
}

/* --------------------------------------------------------------- badge ---- */

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-sunken text-muted border-line",
  success: "bg-success-soft text-success border-success/25",
  warning: "bg-warning-soft text-warning border-warning/25",
  danger: "bg-danger-soft text-danger border-danger/25",
  info: "bg-info-soft text-info border-info/25",
};

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5",
        "text-[11px] font-semibold leading-4",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- stat ---- */

/**
 * A headline number with a label.
 *
 * `tone` colours the value, not the card — a spend figure in rose and an income
 * figure in emerald lets the eye sort a row of stats before reading any of them.
 */
export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
  href,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone | "spend" | "income";
  icon?: ReactNode;
  href?: string;
}) {
  const valueClass =
    tone === "spend"
      ? "text-spend"
      : tone === "income"
        ? "text-income"
        : tone === "danger"
          ? "text-danger"
          : tone === "warning"
            ? "text-warning"
            : tone === "success"
              ? "text-success"
              : "text-ink";

  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
        {icon ? <span className="text-faint">{icon}</span> : null}
      </div>
      <p className={cx("tnum mt-2 text-2xl font-semibold tracking-tight", valueClass)}>{value}</p>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className="card block px-5 py-4 transition-shadow hover:shadow-pop"
      >
        {inner}
      </a>
    );
  }
  return <div className="card px-5 py-4">{inner}</div>;
}

/* --------------------------------------------------------------- money ---- */

/** Signed money. Credits emerald with +, debits rose with −. */
export function Money({
  amount,
  direction,
  exact = false,
  className,
}: {
  amount: unknown;
  direction?: string | null;
  exact?: boolean;
  className?: string;
}) {
  const isCredit = direction === "credit";
  const value = num(amount);
  const formatted = exact ? money(value) : money(value);
  return (
    <span className={cx("tnum", isCredit ? "text-income" : "text-ink", className)}>
      {isCredit ? "+" : ""}
      {formatted}
    </span>
  );
}

/* -------------------------------------------------------------- progress -- */

export function ProgressBar({
  pct,
  tone = "info",
  className,
}: {
  /** 0–100. Values over 100 render full but in a warning colour. */
  pct: number;
  tone?: Tone;
  className?: string;
}) {
  const over = pct > 100;
  const width = Math.max(0, Math.min(100, pct));
  const barTone = over ? "danger" : tone;
  const fill =
    barTone === "success"
      ? "bg-success"
      : barTone === "warning"
        ? "bg-warning"
        : barTone === "danger"
          ? "bg-danger"
          : barTone === "info"
            ? "bg-info"
            : "bg-accent";

  return (
    <div
      className={cx("h-1.5 w-full overflow-hidden rounded-full bg-sunken", className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cx("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${width}%` }} />
    </div>
  );
}

/* ---------------------------------------------------------------- empty ---- */

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? <div className="mb-3 text-faint">{icon}</div> : null}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {body ? <div className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{body}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- table ---- */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cx("w-full border-collapse text-sm", className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  className,
  sortable,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  sortable?: boolean;
}) {
  return (
    <th
      scope="col"
      className={cx(
        "sticky top-0 z-10 border-b border-line bg-surface px-3 py-2.5",
        "text-[11px] font-semibold tracking-wide text-muted uppercase",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        sortable && "cursor-pointer select-none hover:text-ink",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
  colSpan,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        "border-b border-line px-3 py-2.5 align-middle text-ink",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

/* --------------------------------------------------------------- misc ---- */

/** A sector's emoji, or a neutral dot when it has none. */
export function SectorIcon({ icon, className }: { icon?: string | null; className?: string }) {
  if (!icon) {
    return <span className={cx("inline-block size-2 rounded-full bg-faint", className)} aria-hidden />;
  }
  return (
    <span className={cx("inline-block text-base leading-none", className)} aria-hidden>
      {icon}
    </span>
  );
}

/** Compact money for chart axes and dense cells. */
export function CompactMoney({ value, className }: { value: unknown; className?: string }) {
  return <span className={cx("tnum", className)}>{moneyCompact(value)}</span>;
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tnum text-right text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}
