import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Auth layout: one centred column.
 *
 * Kept deliberately bare. Nobody wants a marketing panel next to a password
 * field they are trying to remember.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <Link href="/" className="mb-8 text-sm font-semibold tracking-tight text-ink">
        SaveIt
      </Link>
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-8 max-w-sm text-center text-xs leading-relaxed text-faint">
        Upload a statement instead of typing every expense. Multi-tenant and row-level secured from
        the first migration.
      </p>
    </main>
  );
}
