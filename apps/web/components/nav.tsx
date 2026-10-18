"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/lib/actions/auth";
import { cx } from "@/components/ui";

/**
 * Navigation.
 *
 * One list, rendered two ways: a sidebar at `lg` and a horizontally scrollable
 * tab bar below it. Duplicating the links would mean every new page has to be
 * added in two places, and one of them would eventually be forgotten.
 *
 * `usePathname` is why this is a client component. The active state is a
 * rendering concern, not a data concern, so it does not need the server.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** Exact match only, so /transactions does not also light up /transactions/x. */
  exact?: boolean;
  badge?: number;
};

export function Nav({ items, userEmail }: { items: NavItem[]; userEmail?: string | null }) {
  const pathname = usePathname();

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <>
      {/* ---------------------------------------------------- desktop sidebar */}
      <aside className="hidden shrink-0 border-r border-line bg-surface lg:flex lg:w-60 lg:flex-col">
        <div className="flex h-14 items-center border-b border-line px-5">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight text-ink">
            SaveIt
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item) ? "page" : undefined}
                  className={cx(
                    "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                    isActive(item)
                      ? "bg-accent-soft font-semibold text-ink"
                      : "text-muted hover:bg-sunken hover:text-ink",
                  )}
                >
                  <span className="w-5 shrink-0 text-center text-base leading-none" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.badge && item.badge > 0 ? (
                    <span
                      className={cx(
                        "tnum rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none",
                        isActive(item) ? "bg-accent text-accent-ink" : "bg-sunken text-muted",
                      )}
                    >
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-line px-3 py-3">
          <p className="truncate px-2.5 text-xs text-faint" title={userEmail ?? undefined}>
            {userEmail ?? "Signed in"}
          </p>
          <form action={signOut} className="mt-2">
            <button
              type="submit"
              className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* -------------------------------------------------------- mobile bar */}
      <div className="sticky top-0 z-30 border-b border-line bg-surface lg:hidden">
        <div className="flex h-12 items-center justify-between px-4">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            SaveIt
          </Link>
          <form action={signOut}>
            <button type="submit" className="text-xs font-medium text-muted hover:text-ink">
              Sign out
            </button>
          </form>
        </div>
        <nav
          className="flex gap-1 overflow-x-auto px-2 pb-2"
          aria-label="Primary"
          // Hides the scrollbar on a strip that is meant to be swiped.
          style={{ scrollbarWidth: "none" }}
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item) ? "page" : undefined}
              className={cx(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                isActive(item)
                  ? "bg-accent-soft text-ink"
                  : "bg-sunken text-muted",
              )}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
              {item.badge && item.badge > 0 ? (
                <span className="tnum rounded-full bg-accent px-1 text-[10px] font-bold text-accent-ink">
                  {item.badge > 99 ? "99+" : item.badge}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}
