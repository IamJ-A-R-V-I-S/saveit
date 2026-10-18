import type { ReactNode } from "react";

/**
 * Page title with an optional subtitle and a right-aligned action.
 *
 * Shared so every page has the same vertical rhythm. `sub` is prose, not a
 * second heading — it carries the caveat that makes the numbers honest ("data
 * through …", "this month looks thin").
 */
export function PageHeading({
  title,
  sub,
  action,
}: {
  title: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">{title}</h1>
        {sub ? <div className="mt-1 text-sm text-muted">{sub}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
