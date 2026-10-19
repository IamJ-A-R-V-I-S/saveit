"use client";

import { useState, useTransition } from "react";
import { mergeAccounts } from "@/lib/actions/accounts";
import { accountDuplicateGroups, preferredSurvivor } from "@/lib/account-groups";
import { Badge, Card, CardBody, CardHeader, cx } from "@/components/ui";
import { count, dateLabel, humanize, money } from "@/lib/format";
import type { AccountUsage } from "@/lib/types";

type Feedback = { tone: "ok" | "err"; text: string } | null;

/**
 * Accounts, and the one thing a human needs to fix about them.
 *
 * Ingest creates accounts from whatever the statement's account column says,
 * so `Slice` and `Slice bank` used to become two accounts. Migration 0012 makes
 * new imports fold those spellings onto one row; this card is how the
 * duplicates that already exist get collapsed.
 *
 * Merging is destructive in the sense that the losing account's name disappears
 * from the ledger — but no history is deleted. The RPC moves transactions and
 * documents to the survivor, recomputes their dedup keys (the key embeds the
 * account id), and archives the loser.
 */
export function AccountsCard({
  accounts,
  className,
}: {
  accounts: AccountUsage[];
  className?: string;
}) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();
  const [merged, setMerged] = useState<Set<string>>(new Set());

  const active = accounts.filter((account) => !account.is_archived && !merged.has(account.id));
  const archived = accounts.filter((account) => account.is_archived);
  const duplicates = accountDuplicateGroups(active);

  function merge(keep: AccountUsage, drop: AccountUsage) {
    const confirmed = window.confirm(
      `Merge “${drop.name}” into “${keep.name}”?\n\n` +
        `Every transaction and document on “${drop.name}” moves to “${keep.name}”, ` +
        `and “${drop.name}” is archived. History is never deleted.`,
    );
    if (!confirmed) return;

    setFeedback(null);
    startTransition(async () => {
      const result = await mergeAccounts(keep.id, drop.id);
      if (!result.ok) {
        setFeedback({ tone: "err", text: result.error });
        return;
      }
      setMerged((prev) => new Set([...prev, drop.id]));
      setFeedback({
        tone: "ok",
        text:
          `Merged “${drop.name}” into “${keep.name}”. ` +
          `${count(result.moved)} transaction${result.moved === 1 ? "" : "s"} moved; ` +
          `“${drop.name}” is archived.`,
      });
    });
  }

  return (
    <Card className={className}>
      <CardHeader
        title="Accounts"
        hint="Statements name an account the way it is printed. Two spellings of the same account split your ledger — merge them here."
        action={<Badge tone={duplicates.length > 0 ? "warning" : "neutral"}>{active.length}</Badge>}
      />
      <CardBody className="space-y-4">
        {feedback ? (
          <p
            role="status"
            className={cx(
              "rounded-lg border px-3 py-2 text-xs leading-relaxed",
              feedback.tone === "ok"
                ? "border-success/25 bg-success-soft text-success"
                : "border-danger/25 bg-danger-soft text-danger",
            )}
          >
            {feedback.text}
          </p>
        ) : null}

        {active.length === 0 ? (
          <p className="py-2 text-sm text-muted">
            No accounts yet. One appears the first time an upload or a manual entry names it.
          </p>
        ) : (
          <>
            {duplicates.map((group) => {
              const keep = preferredSurvivor(group);
              const drops = group.filter((account) => account.id !== keep.id);

              return (
                <div
                  key={group.map((account) => account.id).join(":")}
                  className="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2.5"
                >
                  <p className="text-xs font-semibold text-warning">Same account, two spellings</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                    {group.map((account) => `“${account.name}”`).join(" and ")} both normalize to{" "}
                    <span className="font-mono">{keep.normalized_name}</span>. They are being
                    reported as separate accounts.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {drops.map((drop) => (
                      <button
                        key={drop.id}
                        type="button"
                        disabled={pending}
                        onClick={() => merge(keep, drop)}
                        className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                      >
                        Merge “{drop.name}” into “{keep.name}”
                      </button>
                    ))}
                    {group.length === 2 ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => merge(drops[0], keep)}
                        className="rounded-md border border-line-strong px-2.5 py-1 text-[11px] font-semibold text-muted hover:bg-sunken disabled:opacity-50"
                        title={`Keep “${keep.name}” instead`}
                      >
                        Keep “{keep.name}” instead
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}

            <ul className="divide-y divide-line">
              {active.map((account) => (
                <li
                  key={account.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-sm font-medium text-ink">{account.name}</span>
                  <Badge>{humanize(account.kind)}</Badge>
                  {account.manual_only ? (
                    <span className="text-[11px] text-faint">manual only</span>
                  ) : null}

                  <span className="tnum text-[11px] text-muted">
                    {count(account.txn_count)} txn{account.txn_count === 1 ? "" : "s"}
                  </span>
                  <span className="tnum text-[11px] text-muted">{money(account.spend)} out</span>
                  <span className="tnum text-[11px] text-muted">{money(account.income)} in</span>
                  <span className="text-[11px] text-faint">
                    last {dateLabel(account.last_seen)}
                  </span>

                  {active.length > 1 ? (
                    <span className="ml-auto shrink-0">
                      <select
                        aria-label={`Merge ${account.name} into another account`}
                        defaultValue=""
                        disabled={pending}
                        onChange={(event) => {
                          const target = active.find((a) => a.id === event.target.value);
                          // Reset immediately: the select is an action, not a
                          // piece of state, and a failed merge must not leave the
                          // row showing the account it failed to merge into.
                          event.target.value = "";
                          if (target) merge(target, account);
                        }}
                        className="field w-auto py-0.5 pr-6 text-[11px]"
                      >
                        <option value="" disabled>
                          Merge into…
                        </option>
                        {active
                          .filter((other) => other.id !== account.id)
                          .map((other) => (
                            <option key={other.id} value={other.id}>
                              Into “{other.name}”
                            </option>
                          ))}
                      </select>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>

            <p className="border-t border-line pt-3 text-[11px] leading-relaxed text-faint">
              Merging moves every transaction and document to the surviving account and archives
              the other one — nothing is deleted.
              {archived.length > 0
                ? ` ${count(archived.length)} archived account${archived.length === 1 ? "" : "s"} from earlier merges ${archived.length === 1 ? "is" : "are"} hidden from this list.`
                : ""}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
