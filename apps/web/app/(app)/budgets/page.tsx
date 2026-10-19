import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import {
  BudgetForm,
  DeleteBudgetButton,
  DeleteGoalButton,
  GoalForm,
  GoalProgressForm,
} from "@/components/budgets/budget-forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, ProgressBar } from "@/components/ui";
import { getBudgets, getGoals } from "@/lib/data/budgets";
import { getSectors } from "@/lib/data/sectors";
import { count, dateLabel, money, num, percent } from "@/lib/format";

export const metadata: Metadata = { title: "Budgets and goals" };

/**
 * Budgets and goals.
 *
 * Both exist to give the coach a target. Without one it can only describe
 * ("you spent ₹6,250 on Cha"); with one it can nudge ("Eating Out is 40% over
 * with nine days left").
 */
export default async function BudgetsPage() {
  const [budgets, goals, sectors] = await Promise.all([getBudgets(), getGoals(), getSectors()]);

  const existing = new Map(
    budgets.map((b) => [b.sector_slug, { id: b.id, amount: num(b.budget_amount) }]),
  );

  const totalBudget = budgets.reduce((s, b) => s + num(b.budget_amount), 0);
  const totalSpent = budgets.reduce((s, b) => s + num(b.actual_spend), 0);

  return (
    <>
      <PageHeading
        title="Budgets and goals"
        sub="A budget is a ceiling per sector. A goal is a target with a deadline. The coach measures against both."
        action={<GoalForm />}
      />

      {/* ---------------------------------------------------------- budgets -- */}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Monthly budgets"
            hint={
              budgets.length > 0
                ? `${money(totalSpent)} of ${money(totalBudget)} used across ${count(budgets.length)} sector${budgets.length === 1 ? "" : "s"} this month.`
                : "No budgets yet. Set one and the coach can tell you when you're close to it."
            }
          />
          <CardBody>
            {budgets.length === 0 ? (
              <EmptyState
                icon={<span className="text-3xl">◫</span>}
                title="No budgets set"
                body="Start with the sector you spend most on. You can change the number at any time — the coach uses whatever is current."
              />
            ) : (
              <ul className="space-y-4">
                {budgets.map((b) => {
                  const pct = num(b.pct_used);
                  const remaining = num(b.remaining);
                  const over = remaining < 0;
                  const tone = over ? "danger" : pct >= 80 ? "warning" : "success";

                  return (
                    <li key={b.id}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex items-center gap-2 text-sm font-medium text-ink">
                          {b.sector_icon ? <span aria-hidden>{b.sector_icon}</span> : null}
                          {b.sector_name}
                        </span>
                        <span className="flex shrink-0 items-baseline gap-2">
                          <span className="tnum text-sm">
                            {money(b.actual_spend)}{" "}
                            <span className="text-xs text-muted">of {money(b.budget_amount)}</span>
                          </span>
                          <DeleteBudgetButton id={b.id} label={b.sector_name} />
                        </span>
                      </div>

                      <ProgressBar className="mt-1.5" pct={pct} tone={tone} />

                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                        <span className={over ? "font-semibold text-danger" : "text-muted"}>
                          {over
                            ? `${money(Math.abs(remaining))} over`
                            : `${money(remaining)} left`}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="text-faint">{count(b.tx_count)} transactions</span>
                          <Badge tone={tone}>{percent(pct)} used</Badge>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Set a budget" hint="One per sector. Setting it again replaces it." />
          <CardBody>
            <BudgetForm sectors={sectors} existing={existing} />
          </CardBody>
        </Card>
      </div>

      {/* ------------------------------------------------------------ goals -- */}

      <Card className="mt-4">
        <CardHeader
          title="Savings goals"
          hint="Progress is recorded by you — SaveIt does not move money, so it cannot know what you actually put aside."
        />
        <CardBody>
          {goals.length === 0 ? (
            <EmptyState
              icon={<span className="text-3xl">◎</span>}
              title="No goals yet"
              body="A goal gives the coach something to aim at: it can turn a savings opportunity into ‘that covers 40% of your emergency fund’."
            />
          ) : (
            <ul className="grid gap-4 md:grid-cols-2">
              {goals.map((g) => {
                const pct = num(g.pct_complete);
                const reached = g.status === "reached";

                return (
                  <li key={g.id} className="rounded-xl border border-line px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">
                          {g.name}
                          {reached ? <span className="ml-2 text-xs text-success">✓ reached</span> : null}
                          {g.status === "cancelled" ? (
                            <span className="ml-2 text-xs text-faint">cancelled</span>
                          ) : null}
                        </p>
                        <p className="tnum mt-0.5 text-xs text-muted">
                          {money(g.saved_amount)} of {money(g.target_amount)}
                        </p>
                      </div>
                      <DeleteGoalButton id={g.id} name={g.name} />
                    </div>

                    <ProgressBar
                      className="mt-2.5"
                      pct={pct}
                      tone={reached ? "success" : pct >= 60 ? "info" : "neutral"}
                    />

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="tnum text-[11px] text-faint">
                        {percent(pct, 1)} ·{" "}
                        {g.days_left !== null && g.days_left > 0
                          ? `${count(g.days_left)} days to ${dateLabel(g.deadline)}`
                          : g.deadline
                            ? "deadline passed"
                            : "no deadline"}
                      </span>
                      {g.days_left !== null && g.days_left > 0 && num(g.required_daily_saving) > 0 ? (
                        <Badge tone="info">
                          needs {money(g.required_daily_saving)}/day
                        </Badge>
                      ) : null}
                    </div>

                    <div className="mt-3 border-t border-line pt-2.5">
                      <GoalProgressForm
                        id={g.id}
                        target={num(g.target_amount)}
                        saved={num(g.saved_amount)}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
