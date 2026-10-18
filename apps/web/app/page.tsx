import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";

/**
 * Landing page. Signed-in visitors go straight to the dashboard — nobody wants
 * to read marketing copy for an app they already use.
 */
export default async function LandingPage() {
  const user = await currentUser();
  if (user) redirect("/dashboard");

  return (
    <main className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <span className="text-sm font-semibold tracking-tight">SaveIt</span>
        <nav className="flex items-center gap-2">
          <Link
            href="/login"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
        </nav>
      </header>

      <section className="mx-auto w-full max-w-5xl px-6 pb-16 pt-14 sm:pt-20">
        <p className="text-xs font-semibold tracking-widest text-accent uppercase">
          Expense tracking, inverted
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Upload a statement. Skip the forty daily entries.
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          SaveIt reads your bank, UPI or tracker export, categorizes every transaction into a
          taxonomy that grows to match how <em>you</em> describe money, and then tells you where the
          money is actually leaking — with the rupee figure and the transactions behind it.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
          >
            Upload your first statement
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-line-strong px-5 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface"
          >
            I already have an account
          </Link>
        </div>

        <dl className="mt-16 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {[
            {
              k: "99.98%",
              v: "of a real 5,535-row statement categorized with zero model calls",
            },
            {
              k: "2 agents",
              v: "an analyzer on upload, a coach on a schedule watching your patterns",
            },
            {
              k: "0 duplicates",
              v: "re-upload an overlapping statement and nothing is counted twice",
            },
          ].map((item) => (
            <div key={item.k} className="bg-surface px-5 py-6">
              <dt className="tnum text-2xl font-semibold tracking-tight text-accent">{item.k}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-muted">{item.v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="mt-auto border-t border-line">
        <div className="mx-auto w-full max-w-5xl px-6 py-6 text-xs text-faint">
          Your data stays in your own Supabase project. Row-level security scopes every query to you.
        </div>
      </footer>
    </main>
  );
}
