import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeading } from "@/components/page-heading";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { getDashboardSummary } from "@/lib/data/dashboard";
import { getProfile } from "@/lib/data/profile";
import { currentUser } from "@/lib/supabase/server";
import { count } from "@/lib/format";

export const metadata: Metadata = { title: "Get started" };

/**
 * First-run page.
 *
 * Shown after signup and after email confirmation. A brand-new account with an
 * empty dashboard is not a broken app, but it looks like one — so this states
 * plainly that nothing exists yet and what the first upload will do.
 *
 * Once there are transactions it redirects to the dashboard, so the page is
 * never a dead end for a returning user.
 */
export default async function OnboardingPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const [summary, profile] = await Promise.all([getDashboardSummary(), getProfile()]);

  if (summary && summary.total_transactions > 0) redirect("/dashboard");

  return (
    <>
      <PageHeading
        title={`Welcome${profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}`}
        sub="One upload is the whole setup. Everything after this gets better on its own."
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader
            title="Start with a statement"
            hint="A tracker export is the easiest first file. A bank CSV works too. A scanned PDF is fine but slower."
          />
          <CardBody className="space-y-4">
            <ol className="space-y-3">
              <Step n={1} title="Upload">
                Drop in a CSV, XLSX, PDF or a photo. The parser detects the delimiter, the header
                row and which column is the amount, the date and the description — you don&apos;t map
                anything.
              </Step>
              <Step n={2} title="It categorizes itself">
                148 products seed on the first upload, matched against your descriptions. On the
                statement SaveIt was built against, {""}
                <strong className="font-semibold text-ink">
                  5,534 of 5,535 rows
                </strong>{" "}
                categorized with no model call at all.
              </Step>
              <Step n={3} title="Clear the review queue">
                Whatever it isn&apos;t sure about is parked rather than guessed. Each decision you
                make writes an alias, so the same description never needs deciding twice.
              </Step>
              <Step n={4} title="Ask the coach">
                With three months of data it can rank what would save you the most, in rupees, with
                the transactions behind each claim.
              </Step>
            </ol>

            <Link
              href="/upload"
              className="inline-block rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
            >
              ⇪ Upload your first statement
            </Link>
          </CardBody>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="No statement handy?" />
            <CardBody className="space-y-3 text-sm leading-relaxed text-muted">
              <p>
                You can type expenses in directly. Statements miss things anyway — cash, split bills,
                a subscription paid from an account you never export — and both routes feed the same
                ledger.
              </p>
              <Link
                href="/transactions"
                className="inline-block rounded-lg border border-line-strong px-3.5 py-2 text-xs font-semibold text-ink hover:bg-sunken"
              >
                Add a transaction manually →
              </Link>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Worth setting up early" />
            <CardBody>
              <ul className="space-y-2.5 text-xs leading-relaxed text-muted">
                <li className="flex justify-between gap-3">
                  <span>A budget on your biggest sector</span>
                  <Link href="/budgets" className="shrink-0 font-semibold text-accent hover:underline">
                    Budgets →
                  </Link>
                </li>
                <li className="flex justify-between gap-3">
                  <span>Telegram, so the coach can nudge you</span>
                  <Link href="/settings" className="shrink-0 font-semibold text-accent hover:underline">
                    Settings →
                  </Link>
                </li>
                <li className="flex justify-between gap-3">
                  <span>Check the backend is deployed</span>
                  <Link href="/settings" className="shrink-0 font-semibold text-accent hover:underline">
                    Settings →
                  </Link>
                </li>
              </ul>
              <p className="mt-3 border-t border-line pt-2.5 text-[11px] text-faint">
                Signed in as {profile?.email ?? user.email} ·{" "}
                {count(summary?.document_count ?? 0)} documents uploaded
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="tnum mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-ink">
        {n}
      </span>
      <span className="text-sm leading-relaxed text-muted">
        <span className="block font-semibold text-ink">{title}</span>
        {children}
      </span>
    </li>
  );
}
