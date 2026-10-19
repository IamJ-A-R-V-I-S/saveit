import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import { AccountsCard } from "@/components/settings/accounts-card";
import { BackendStatus } from "@/components/settings/backend-status";
import { ProfileForm, SignOutButton, TelegramForm } from "@/components/settings/settings-forms";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { getAccountsWithUsage } from "@/lib/data/accounts";
import { getProfile } from "@/lib/data/profile";
import { FUNCTIONS_URL, SUPABASE_URL } from "@/lib/env";
import { count } from "@/lib/format";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const [profile, accounts] = await Promise.all([getProfile(), getAccountsWithUsage()]);

  return (
    <>
      <PageHeading title="Settings" sub="Your profile, how the coach reaches you, and what this app is pointed at." />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" hint="Used in the coach's messages and to scope your data." />
          <CardBody>
            <ProfileForm profile={profile} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Telegram"
            hint="The coach pushes its top opportunities here. The dashboard keeps the full detail."
          />
          <CardBody>
            <TelegramForm profile={profile} />
          </CardBody>
        </Card>
      </div>

      <AccountsCard accounts={accounts} className="mt-4" />

      <Card className="mt-4">
        <CardHeader
          title="Backend"
          hint="SaveIt's agents run as Supabase edge functions, deployed separately from this app. Check that they're there."
        />
        <CardBody>
          <BackendStatus initialBaseUrl={FUNCTIONS_URL} />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader title="This installation" hint="Everything here is public by design — the anon key is scoped by row-level security." />
        <CardBody>
          <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
            <Row label="Supabase project">
              <span className="font-mono text-[11px] break-all">{SUPABASE_URL}</span>
            </Row>
            <Row label="Functions base">
              <span className="font-mono text-[11px] break-all">{FUNCTIONS_URL}</span>
            </Row>
            <Row label="Signed in as">
              <span className="text-xs">{profile?.email ?? "—"}</span>
            </Row>
            <Row label="Daily model-call cap">
              <span className="tnum text-xs">{count(profile?.llm_daily_cap ?? 0)}</span>
            </Row>
          </dl>

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-faint">
            The service-role key is never sent to this app. It lives only in the edge functions, as a
            Supabase secret, so no bug in a page can read another user&apos;s ledger — row-level
            security applies to every query made from here, including through the views.
          </p>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader title="Session" />
        <CardBody>
          <SignOutButton />
        </CardBody>
      </Card>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
