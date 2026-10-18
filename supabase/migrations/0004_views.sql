-- =============================================================================
-- SaveIt — 0004 : analytics layer
--
-- Everything the Coach and the Dashboard need, computed in SQL.
-- The Coach never sends raw transactions to an LLM — it sends these
-- aggregates. That keeps token use tiny and the analysis accurate.
--
-- SECURITY: every view below is created `with (security_invoker = true)`.
-- Postgres views otherwise run with the *owner's* privileges, which would
-- silently bypass the RLS policies in 0002 and let any authenticated user
-- read every user's ledger. security_invoker makes the view apply the
-- querying role's RLS policies instead. Requires Postgres 15+ (we're on 17).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- signed amount helper : debit is money out (negative), credit is money in
-- -----------------------------------------------------------------------------
create or replace function public.signed_amount(t public.transactions)
returns numeric
language sql
immutable
as $$
  select case when t.direction = 'credit' then t.amount else -t.amount end;
$$;

-- -----------------------------------------------------------------------------
-- monthly spend by sector
-- -----------------------------------------------------------------------------
create or replace view public.v_monthly_sector_spend
with (security_invoker = true)
as
select
  t.user_id,
  date_trunc('month', t.occurred_at)::date as month,
  s.id                                     as sector_id,
  s.slug                                   as sector_slug,
  s.name                                   as sector_name,
  s.icon                                   as sector_icon,
  sum(t.amount)                            as spend,
  count(*)::integer                        as tx_count
from public.transactions t
join public.sectors s on s.id = coalesce(
  (select p.sector_id from public.products p where p.id = t.product_id),
  (select id from public.sectors where slug = 'uncategorized')
)
where t.direction = 'debit'
group by t.user_id, date_trunc('month', t.occurred_at)::date,
         s.id, s.slug, s.name, s.icon;

-- -----------------------------------------------------------------------------
-- monthly spend by product (the actionable level: "Cha, 785 times, ₹6,250")
-- -----------------------------------------------------------------------------
create or replace view public.v_monthly_product_spend
with (security_invoker = true)
as
select
  t.user_id,
  date_trunc('month', t.occurred_at)::date as month,
  p.id                                     as product_id,
  p.name                                   as product_name,
  p.sector_id,
  s.slug                                   as sector_slug,
  s.name                                   as sector_name,
  sum(t.amount)                            as spend,
  count(*)::integer                        as tx_count,
  round(avg(t.amount), 2)::numeric         as avg_ticket
from public.transactions t
join public.products p on p.id = t.product_id
join public.sectors  s on s.id = p.sector_id
where t.direction = 'debit'
group by t.user_id, date_trunc('month', t.occurred_at)::date,
         p.id, p.name, p.sector_id, s.slug, s.name;

-- -----------------------------------------------------------------------------
-- merchant/description frequency : what the user actually pays for, raw.
-- Powers "you paid 'Cha' 785 times" evidence lookups.
-- -----------------------------------------------------------------------------
create or replace view public.v_description_frequency
with (security_invoker = true)
as
select
  t.user_id,
  lower(trim(t.raw_description)) as description_norm,
  t.product_id,
  count(*)::integer              as occurrences,
  sum(t.amount)                  as total_spend,
  min(t.occurred_at)::date       as first_seen,
  max(t.occurred_at)::date       as last_seen
from public.transactions t
where t.direction = 'debit'
  and t.raw_description is not null
  and trim(t.raw_description) <> ''
group by t.user_id, lower(trim(t.raw_description)), t.product_id;

-- -----------------------------------------------------------------------------
-- coverage : which months are well covered vs sparse.
-- Critical because statements arrive partial — the Coach must not report a
-- fake "you saved money this month" just because rows are missing.
-- -----------------------------------------------------------------------------
create or replace view public.v_monthly_coverage
with (security_invoker = true)
as
select
  t.user_id,
  date_trunc('month', t.occurred_at)::date as month,
  count(*)::integer                        as tx_count,
  sum(case when t.direction = 'debit'  then t.amount else 0 end) as total_spend,
  sum(case when t.direction = 'credit' then t.amount else 0 end) as total_income,
  sum(case when t.categorize_status = 'review'  then 1 else 0 end)::integer as needs_review,
  sum(case when t.categorize_status = 'pending' then 1 else 0 end)::integer as pending,
  sum(case when t.product_id is null then 1 else 0 end)::integer            as uncategorized,
  round(
    100.0 * sum(case when t.product_id is not null then 1 else 0 end) / count(*),
    1
  )::numeric as categorize_pct
from public.transactions t
group by t.user_id, date_trunc('month', t.occurred_at)::date;

-- -----------------------------------------------------------------------------
-- budgets with actual spend attached (current month)
-- -----------------------------------------------------------------------------
create or replace view public.v_budget_status
with (security_invoker = true)
as
select
  b.id,
  b.user_id,
  b.sector_id,
  s.slug              as sector_slug,
  s.name              as sector_name,
  s.icon              as sector_icon,
  b.period,
  b.amount            as budget_amount,
  coalesce(a.actual, 0)::numeric as actual_spend,
  coalesce(a.tx_count, 0)::integer as tx_count,
  case
    when b.amount = 0 then null
    else round(100.0 * coalesce(a.actual, 0) / b.amount, 1)
  end::numeric as pct_used,
  (b.amount - coalesce(a.actual, 0))::numeric as remaining
from public.budgets b
join public.sectors s on s.id = b.sector_id
left join lateral (
  select sum(t.amount) as actual, count(*) as tx_count
  from public.transactions t
  where t.user_id = b.user_id
    and t.direction = 'debit'
    and t.product_id is not null
    and (select p.sector_id from public.products p where p.id = t.product_id) = b.sector_id
    and t.occurred_at >= date_trunc('month', now())
    and t.occurred_at <  date_trunc('month', now()) + interval '1 month'
) a on true;

-- -----------------------------------------------------------------------------
-- goals with progress
-- -----------------------------------------------------------------------------
create or replace view public.v_goal_status
with (security_invoker = true)
as
select
  g.id,
  g.user_id,
  g.name,
  g.target_amount,
  g.saved_amount,
  g.deadline,
  g.status,
  case
    when g.target_amount = 0 then null
    else round(100.0 * g.saved_amount / g.target_amount, 1)
  end::numeric as pct_complete,
  (g.target_amount - g.saved_amount)::numeric as remaining,
  g.deadline - now()::date as days_left,
  case
    when g.deadline is null or g.deadline <= now()::date then null
    else round(
      (g.target_amount - g.saved_amount) /
      greatest(1, (g.deadline - now()::date)),
      2
    )
  end::numeric as required_daily_saving
from public.goals g;

-- -----------------------------------------------------------------------------
-- dashboard summary : one row per user, everything the home screen needs
-- -----------------------------------------------------------------------------
create or replace view public.v_dashboard_summary
with (security_invoker = true)
as
select
  u.id as user_id,
  (select count(*) from public.transactions t where t.user_id = u.id)::integer
    as total_transactions,
  (select sum(t.amount) from public.transactions t
     where t.user_id = u.id and t.direction = 'debit')::numeric
    as total_spend,
  (select sum(t.amount) from public.transactions t
     where t.user_id = u.id and t.direction = 'credit')::numeric
    as total_income,
  (select min(t.occurred_at)::date from public.transactions t where t.user_id = u.id)
    as first_transaction,
  (select max(t.occurred_at)::date from public.transactions t where t.user_id = u.id)
    as last_transaction,
  (select count(*) from public.transactions t
     where t.user_id = u.id and t.categorize_status = 'review')::integer
    as needs_review,
  (select count(*) from public.products p
     where p.user_id = u.id and p.status = 'active')::integer
    as product_count,
  (select count(*) from public.documents d where d.user_id = u.id)::integer
    as document_count
from public.profiles u;

-- -----------------------------------------------------------------------------
-- dedup key generator (mirrors supabase/functions/_shared/normalize.ts exactly,
-- so Postgres can recompute a key during a manual backfill).
--
-- Timestamp precision is SECONDS, not minutes. Real data forces this: the sample
-- statement contains four pairs of genuinely distinct transactions that are
-- identical to the minute, e.g.
--     SBI-Reja | 2026-06-28 19:10:52 | -58.00 | Grocery
--     SBI-Reja | 2026-06-28 19:10:22 | -58.00 | Grocery
-- and a pair of Rs.542 exam-fee payments one minute apart -- one for the user,
-- one "For CR". At minute precision those rows are silently dropped as
-- duplicates. At second precision the sample dedups to 5535/5535 with zero loss.
--
-- p_occurrence disambiguates rows that are identical even to the second (or
-- date-only statements with no time component at all). It is assigned
-- deterministically by position within a batch, so re-uploading the same file
-- reproduces the same keys and still dedups correctly.
-- -----------------------------------------------------------------------------
create or replace function public.make_dedup_key(
  p_user_id     uuid,
  p_account_id  uuid,
  p_occurred_at timestamptz,
  p_amount      numeric,
  p_description text,
  p_occurrence  integer default 0
)
returns text
language sql
immutable
as $$
  select encode(
    digest(
      p_user_id::text || '|' ||
      coalesce(p_account_id::text, '') || '|' ||
      to_char(p_occurred_at at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') || '|' ||
      trim(to_char(p_amount, 'FM999999990.00')) || '|' ||
      btrim(regexp_replace(
        lower(coalesce(p_description, '')),
        '[^a-z0-9]+', ' ', 'g'
      )) || '|' ||
      coalesce(p_occurrence, 0)::text,
      'sha256'
    ),
    'hex'
  );
$$;

-- -----------------------------------------------------------------------------
-- merge_products : collapse near-duplicate products (the hybrid taxonomy's
-- self-cleaning step). Moves transactions + aliases, then archives the loser.
-- -----------------------------------------------------------------------------
create or replace function public.merge_products(
  p_keep_id uuid,
  p_drop_id uuid
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if p_keep_id = p_drop_id then
    raise exception 'cannot merge a product into itself';
  end if;

  if not exists (select 1 from public.products where id = p_keep_id)
     or not exists (select 1 from public.products where id = p_drop_id) then
    raise exception 'one of the products does not exist';
  end if;

  update public.transactions set product_id = p_keep_id where product_id = p_drop_id;
  update public.aliases      set product_id = p_keep_id where product_id = p_drop_id;
  update public.corrections  set old_product_id = p_keep_id where old_product_id = p_drop_id;
  update public.insights     set product_id = p_keep_id where product_id = p_drop_id;

  update public.products
     set status      = 'merged',
         merged_into = p_keep_id,
         use_count   = 0
   where id = p_drop_id;

  update public.products
     set use_count = (select count(*) from public.transactions where product_id = p_keep_id)
   where id = p_keep_id;
end;
$$;

revoke execute on function public.merge_products(uuid, uuid) from public;
grant execute on function public.merge_products(uuid, uuid) to authenticated;
