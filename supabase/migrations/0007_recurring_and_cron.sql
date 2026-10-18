-- =============================================================================
-- SaveIt — 0007 : recurring-payment detection + the Coach schedule
-- =============================================================================

-- -----------------------------------------------------------------------------
-- find_recurring_transactions
--
-- Feeds the Coach's "recurring" candidate class: rent, subscriptions, a weekly
-- recharge. Same product + same amount + a regular gap.
--
-- The gap filter (5..400 days) is deliberate. A daily Rs 10 chai has a median
-- gap of ~1 day and would flood this result -- but that pattern is already
-- caught far better by the "frequency" candidate class, which is about *count*,
-- not cadence. Separating the two keeps each signal honest.
-- -----------------------------------------------------------------------------
create or replace function public.find_recurring_transactions(
  p_user_id uuid,
  p_since   date default null
)
returns table (
  product_id      uuid,
  product_name    text,
  sector_slug     text,
  amount          numeric,
  occurrences     bigint,
  total_spend     numeric,
  median_gap_days numeric,
  sample_ids      uuid[]
)
language sql
stable
as $$
  with tx as (
    select
      t.id,
      t.product_id,
      t.amount,
      t.occurred_at,
      p.name    as product_name,
      s.slug    as sector_slug
    from public.transactions t
    join public.products p on p.id = t.product_id
    join public.sectors  s on s.id = p.sector_id
    where t.user_id = p_user_id
      and t.direction = 'debit'
      and (p_since is null or (t.occurred_at at time zone 'utc')::date >= p_since)
  ),
  grouped as (
    select
      product_id,
      min(product_name) as product_name,
      min(sector_slug)  as sector_slug,
      amount,
      count(*)                                 as occurrences,
      sum(amount)                              as total_spend,
      array_agg(id           order by occurred_at) as ids,
      array_agg(occurred_at  order by occurred_at) as times
    from tx
    group by product_id, amount
    having count(*) >= 3
  ),
  with_gaps as (
    select
      g.*,
      (
        select percentile_cont(0.5) within group (
                 order by extract(epoch from (g.times[i + 1] - g.times[i])) / 86400.0
               )
        from generate_series(1, array_length(g.times, 1) - 1) as i
      ) as median_gap
    from grouped g
  ),
  ranked as (
    select
      w.product_id, w.product_name, w.sector_slug, w.amount,
      w.occurrences, w.total_spend, w.median_gap, w.ids,
      row_number() over (order by w.total_spend desc) as rn
    from with_gaps w
    where w.median_gap between 5 and 400
  )
  select
    r.product_id,
    r.product_name,
    r.sector_slug,
    r.amount,
    r.occurrences,
    r.total_spend,
    round(r.median_gap::numeric, 1) as median_gap_days,
    -- Most recent 12 ids only. The full array can be hundreds of entries and the
    -- Coach only needs enough to make the claim clickable.
    (
      select coalesce(array_agg(x order by ord desc), '{}'::uuid[])
      from (
        select x, ord from unnest(r.ids) with ordinality as t(x, ord)
        order by ord desc limit 12
      ) recent
    ) as sample_ids
  from ranked r
  where r.rn <= 20
  order by r.total_spend desc;
$$;

revoke execute on function public.find_recurring_transactions(uuid, date) from public;
grant execute on function public.find_recurring_transactions(uuid, date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The Coach schedule
--
-- pg_cron fires pg_net, which POSTs to the coach-cron edge function. That
-- function fans out over users; the database never needs to know who they are.
--
-- SECRETS: the URL and the shared secret are read from GUCs, NOT hardcoded here.
-- A cron job definition is visible to anyone with dashboard access, so baking a
-- service-role key into it would leak it. coach-cron validates the shared
-- secret and then uses the service-role key from its own environment, where it
-- belongs.
--
-- To activate (one-time, in the SQL editor):
--
--   alter database postgres set app.settings.saveit_cron_url =
--     'https://<project-ref>.supabase.co/functions/v1/coach-cron';
--   alter database postgres set app.settings.saveit_cron_secret =
--     '<a long random string, also set as the CRON_SECRET edge function secret>';
--
-- Then re-run this migration (or the DO block below). Until both GUCs are set
-- the schedule is skipped with a NOTICE, so the migration is safe to apply to a
-- fresh database with no configuration.
-- -----------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
declare
  v_url    text := nullif(current_setting('app.settings.saveit_cron_url', true), '');
  v_secret text := nullif(current_setting('app.settings.saveit_cron_secret', true), '');
begin
  if v_url is null or v_secret is null then
    raise notice
      'saveit: coach schedule NOT created. Set app.settings.saveit_cron_url and '
      'app.settings.saveit_cron_secret, then re-run migration 0007.';
    return;
  end if;

  perform cron.unschedule(jobname)
  from (select jobname from cron.job where jobname like 'saveit-coach%') j;

  -- Monday 02:00 UTC. Weekly is the right cadence for spending advice: daily is
  -- noise, monthly arrives too late to change behaviour inside the month.
  perform cron.schedule(
    'saveit-coach-weekly',
    '0 2 * * 1',
    format(
      $fmt$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object(
                     'content-type', 'application/json',
                     'x-cron-secret', %L
                   ),
        body    := jsonb_build_object('reason', 'weekly'),
        timeout_milliseconds := 300000
      );
      $fmt$,
      v_url, v_secret
    )
  );

  -- First-of-month at 02:30 UTC: the monthly summary lands right after the
  -- window closes, while the week run keeps momentum mid-month.
  perform cron.schedule(
    'saveit-coach-monthly',
    '30 2 1 * *',
    format(
      $fmt$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object(
                     'content-type', 'application/json',
                     'x-cron-secret', %L
                   ),
        body    := jsonb_build_object('reason', 'monthly', 'months', 1),
        timeout_milliseconds := 600000
      );
      $fmt$,
      v_url, v_secret
    )
  );

  raise notice 'saveit: coach schedule created (weekly Mon 02:00, monthly 1st 02:30 UTC)';
end;
$$;
