-- =============================================================================
-- SaveIt — database integration test
--
-- Exercises what unit tests cannot: the signup trigger, RLS policies, the
-- use_count transition-table triggers, dedup-on-conflict idempotency, the
-- analytics views, and merge_products().
--
-- Everything is scoped to a throwaway user and removed at the end, so this is
-- safe to run against a live project. Results are collected into a table rather
-- than raised as NOTICEs, because the Supabase SQL API does not return NOTICE
-- output -- and each test catches its own exception so one failure does not hide
-- the rest.
--
-- Run the whole file as a single statement batch (one session).
-- =============================================================================

drop table if exists public._saveit_test_results;
create unlogged table public._saveit_test_results (
  n       serial primary key,
  name    text not null,
  passed  boolean not null,
  detail  text
);

-- ---------------------------------------------------------------------------
-- helper: record a result
-- ---------------------------------------------------------------------------
create or replace function public._saveit_assert(p_name text, p_ok boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into public._saveit_test_results (name, passed, detail)
  values (p_name, p_ok, p_detail);
end $$;

-- ===========================================================================
-- 1. signup trigger must create a profile with defaults
-- ===========================================================================
do $t$
declare
  p record;
begin
  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_sso_user
    ) values (
      '00000000-0000-0000-0000-000000000000',
      'aaaaaaaa-0000-0000-0000-000000000001',
      'authenticated', 'authenticated',
      'dbtest@example.invalid',
      crypt('not-a-real-password', gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"DB Test"}'::jsonb,
      false
    );

    select * into p from public.profiles
     where id = 'aaaaaaaa-0000-0000-0000-000000000001';

    perform public._saveit_assert(
      'signup trigger creates profile',
      p.id is not null and p.full_name = 'DB Test'
        and p.default_currency = 'INR' and p.llm_daily_cap = 200,
      case when p.id is null then 'no profile row created'
           else format('name=%s currency=%s cap=%s', p.full_name, p.default_currency, p.llm_daily_cap)
      end);
  exception when others then
    perform public._saveit_assert('signup trigger creates profile', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 2. seed products (including a deliberate near-duplicate pair) + an account
-- ===========================================================================
do $t$
declare n integer;
begin
  begin
    insert into public.products (user_id, sector_id, name, normalized_name, is_seeded)
    select 'aaaaaaaa-0000-0000-0000-000000000001',
           (select id from public.sectors where slug = v.slug),
           v.name, v.norm, true
    from (values
      ('Cha',         'cha',        'food_out'),
      ('Coca-Cola',   'cocacola',   'food_out'),
      ('Idli sambar', 'idlisambar', 'food_out'),
      ('Idli-sambar', 'idlisambar2','food_out'),
      ('Rent',        'rent',       'housing'),
      ('Auto',        'auto',       'transport')
    ) as v(name, norm, slug);

    insert into public.accounts (user_id, name, kind, manual_only)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'Test SBI', 'bank', false);

    select count(*) into n from public.products
     where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    perform public._saveit_assert('seed 6 products + 1 account', n = 6, 'products=' || n);
  exception when others then
    perform public._saveit_assert('seed 6 products + 1 account', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 3a. second-precision dedup: 5 rows one second apart must ALL survive
--     (minute precision would collapse them to 1)
-- ===========================================================================
do $t$
declare
  n integer;
  v_acct uuid;
  v_prod uuid;
begin
  begin
    select id into v_acct from public.accounts where name = 'Test SBI';
    select id into v_prod from public.products
     where normalized_name = 'cha' and user_id = 'aaaaaaaa-0000-0000-0000-000000000001';

    insert into public.transactions
      (user_id, account_id, product_id, amount, direction, occurred_at,
       raw_description, dedup_key, categorize_status, confidence)
    select 'aaaaaaaa-0000-0000-0000-000000000001', v_acct, v_prod, 10, 'debit',
           '2026-06-28 19:10:52+00'::timestamptz + (g || ' seconds')::interval,
           'Cha',
           public.make_dedup_key('aaaaaaaa-0000-0000-0000-000000000001', v_acct,
             '2026-06-28 19:10:52+00'::timestamptz + (g || ' seconds')::interval,
             10, 'Cha', 0),
           'auto', 0.99
    from generate_series(0, 4) g
    on conflict (user_id, dedup_key) do nothing;

    select count(*) into n from public.transactions
     where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    perform public._saveit_assert(
      'second-precision dedup keeps 5 distinct rows', n = 5, 'rows=' || n);
  exception when others then
    perform public._saveit_assert('second-precision dedup keeps 5 distinct rows', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 3b. re-inserting the identical batch must add nothing (idempotent re-upload)
-- ===========================================================================
do $t$
declare
  n integer;
  v_acct uuid;
  v_prod uuid;
begin
  begin
    select id into v_acct from public.accounts where name = 'Test SBI';
    select id into v_prod from public.products
     where normalized_name = 'cha' and user_id = 'aaaaaaaa-0000-0000-0000-000000000001';

    insert into public.transactions
      (user_id, account_id, product_id, amount, direction, occurred_at,
       raw_description, dedup_key, categorize_status, confidence)
    select 'aaaaaaaa-0000-0000-0000-000000000001', v_acct, v_prod, 10, 'debit',
           '2026-06-28 19:10:52+00'::timestamptz + (g || ' seconds')::interval,
           'Cha',
           public.make_dedup_key('aaaaaaaa-0000-0000-0000-000000000001', v_acct,
             '2026-06-28 19:10:52+00'::timestamptz + (g || ' seconds')::interval,
             10, 'Cha', 0),
           'auto', 0.99
    from generate_series(0, 4) g
    on conflict (user_id, dedup_key) do nothing;

    select count(*) into n from public.transactions
     where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    perform public._saveit_assert(
      're-upload is idempotent (0 new rows)', n = 5, 'rows=' || n);
  exception when others then
    perform public._saveit_assert('re-upload is idempotent (0 new rows)', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 4. use_count maintained by the INSERT transition-table trigger
-- ===========================================================================
do $t$
declare n integer;
begin
  begin
    select use_count into n from public.products
     where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and normalized_name = 'cha';
    perform public._saveit_assert('use_count maintained on INSERT', n = 5, 'use_count=' || coalesce(n::text,'null'));
  exception when others then
    perform public._saveit_assert('use_count maintained on INSERT', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 5. analytics views aggregate correctly
-- ===========================================================================
do $t$
declare
  v_spend numeric;
  v_months integer;
  v_dash integer;
begin
  begin
    select coalesce(sum(spend),0) into v_spend from public.v_monthly_product_spend
     where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    select count(*) into v_months from public.v_monthly_coverage
     where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    select total_transactions into v_dash from public.v_dashboard_summary
     where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';

    perform public._saveit_assert(
      'views aggregate correctly',
      v_spend = 50 and v_months = 1 and v_dash = 5,
      format('spend=%s months=%s dashTx=%s', v_spend, v_months, v_dash));
  exception when others then
    perform public._saveit_assert('views aggregate correctly', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 6. views are security_invoker (otherwise they bypass RLS entirely)
-- ===========================================================================
do $t$
declare n integer;
begin
  begin
    select count(*) into n
      from pg_class c join pg_namespace nn on nn.oid = c.relnamespace
     where nn.nspname = 'public' and c.relkind = 'v'
       and c.relname like 'v\_%'
       and not (c.reloptions::text like '%security_invoker=true%');
    perform public._saveit_assert(
      'all analytics views are security_invoker', n = 0,
      n || ' view(s) missing security_invoker');
  exception when others then
    perform public._saveit_assert('all analytics views are security_invoker', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 7. merge_products collapses a duplicate and repoints transactions
-- ===========================================================================
do $t$
declare
  v_keep uuid; v_drop uuid;
  n_active integer; n_merged integer;
begin
  begin
    select id into v_keep from public.products
     where user_id='aaaaaaaa-0000-0000-0000-000000000001' and name='Idli sambar';
    select id into v_drop from public.products
     where user_id='aaaaaaaa-0000-0000-0000-000000000001' and name='Idli-sambar';

    perform public.merge_products(v_keep, v_drop);

    select count(*) into n_active from public.products
     where user_id='aaaaaaaa-0000-0000-0000-000000000001' and status='active';
    select count(*) into n_merged from public.products
     where user_id='aaaaaaaa-0000-0000-0000-000000000001' and status='merged';

    perform public._saveit_assert(
      'merge_products archives the duplicate',
      n_active = 5 and n_merged = 1,
      format('active=%s merged=%s', n_active, n_merged));
  exception when others then
    perform public._saveit_assert('merge_products archives the duplicate', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 8. merge_products refuses self-merge
-- ===========================================================================
do $t$
declare v_id uuid;
begin
  select id into v_id from public.products
   where user_id='aaaaaaaa-0000-0000-0000-000000000001' and name='Rent';
  begin
    perform public.merge_products(v_id, v_id);
    perform public._saveit_assert('merge_products rejects self-merge', false, 'no exception raised');
  exception when others then
    perform public._saveit_assert(
      'merge_products rejects self-merge',
      sqlerrm like '%cannot merge a product into itself%', sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 9. RLS is enabled on every user-scoped table
-- ===========================================================================
do $t$
declare n integer;
begin
  begin
    select count(*) into n
      from pg_class c join pg_namespace nn on nn.oid = c.relnamespace
     where nn.nspname='public' and c.relkind='r' and not c.relrowsecurity
       and c.relname in ('profiles','products','aliases','accounts','documents',
                         'transactions','corrections','insights','budgets','goals',
                         'llm_usage','sectors');
    perform public._saveit_assert('RLS enabled on all 12 tables', n = 0,
      n || ' table(s) without RLS');
  exception when others then
    perform public._saveit_assert('RLS enabled on all 12 tables', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 10. use_count DELETE trigger + recount repair function
-- ===========================================================================
do $t$
declare n integer; fixed integer;
begin
  begin
    delete from public.transactions
     where user_id='aaaaaaaa-0000-0000-0000-000000000001' and amount = 10;

    select use_count into n from public.products
     where user_id='aaaaaaaa-0000-0000-0000-000000000001' and normalized_name='cha';
    perform public._saveit_assert('use_count decremented on DELETE', n = 0, 'use_count=' || coalesce(n::text,'null'));

    select public.recount_product_use_counts() into fixed;
    perform public._saveit_assert('recount_product_use_counts runs', fixed is not null,
      'rows corrected=' || coalesce(fixed::text,'null'));
  exception when others then
    perform public._saveit_assert('use_count DELETE / recount', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- 11. use_count UPDATE trigger: repointing a transaction moves the counter
--     from the old product to the new one, in a single statement.
-- ===========================================================================
do $t$
declare v_acct uuid; v_rent uuid; v_auto uuid;
begin
  begin
    select id into v_acct from public.accounts where name = 'Test SBI';
    select id into v_rent from public.products
     where user_id='aaaaaaaa-0000-0000-0000-000000000001' and normalized_name='rent';
    select id into v_auto from public.products
     where user_id='aaaaaaaa-0000-0000-0000-000000000001' and normalized_name='auto';

    insert into public.transactions
      (user_id, account_id, product_id, amount, direction, occurred_at,
       raw_description, dedup_key)
    values ('aaaaaaaa-0000-0000-0000-000000000001', v_acct, v_auto, 17, 'debit',
            '2026-06-01 10:00:00+00', 'Auto', 'dk-update-test-1');

    update public.transactions set product_id = v_rent where dedup_key = 'dk-update-test-1';

    perform public._saveit_assert(
      'use_count moves on UPDATE',
      (select use_count from public.products where id = v_rent) = 1
        and (select use_count from public.products where id = v_auto) = 0,
      format('rent=%s auto=%s',
        (select use_count from public.products where id = v_rent),
        (select use_count from public.products where id = v_auto)));
  exception when others then
    perform public._saveit_assert('use_count moves on UPDATE', false, sqlerrm);
  end;
end $t$;

-- ===========================================================================
-- cleanup: deleting the auth user cascades everything
-- ===========================================================================
delete from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- ===========================================================================
-- report
--
-- The Supabase SQL API returns only the LAST statement's result set, so
-- everything is folded into one row per test plus a summary object. Drop the
-- helper table and function in a follow-up call (see run-db-tests.sh).
-- ===========================================================================
select jsonb_build_object(
  'summary', (
    select jsonb_build_object(
      'total',  count(*),
      'passed', count(*) filter (where passed),
      'failed', count(*) filter (where not passed)
    ) from public._saveit_test_results
  ),
  'cleanup', (
    select jsonb_build_object(
      'leftover_users',    (select count(*) from auth.users where email = 'dbtest@example.invalid'),
      'leftover_profiles', (select count(*) from public.profiles   where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
      'leftover_products', (select count(*) from public.products   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
      'leftover_accounts', (select count(*) from public.accounts   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
      'leftover_tx',       (select count(*) from public.transactions where user_id = 'aaaaaaaa-0000-0000-0000-000000000001')
    )
  ),
  'tests', coalesce((
    select jsonb_agg(jsonb_build_object(
             'n', n, 'name', name, 'passed', passed, 'detail', detail)
             order by n)
    from public._saveit_test_results
  ), '[]'::jsonb)
) as report;
