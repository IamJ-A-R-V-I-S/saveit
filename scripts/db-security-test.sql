-- =============================================================================
-- SaveIt -- SECURITY DEFINER regression test (migration 0009)
--
-- Proves that merge_products() cannot be used across tenants. Two throwaway
-- users are created; the "attacker" runs with a genuine `authenticated` role
-- and JWT claims, exactly as a PostgREST request would, and tries to merge the
-- victim's product into their own.
--
-- Self-cleaning: deleting the auth rows cascades every owned row away. The
-- final SELECT is the report (the SQL API returns only the last result set).
-- =============================================================================

create table if not exists public._saveit_sec_results (n serial, name text, ok boolean, detail text);
truncate public._saveit_sec_results;

do $$
declare
  v_victim   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_attacker uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_food     uuid := (select id from public.sectors where slug = 'food_out');
  v_acct_v   uuid; v_acct_a uuid;
  v_prod_v   uuid; v_prod_a uuid; v_prod_a2 uuid;
  v_tx_v     uuid;
  v_after    uuid;
  v_err      text;
begin
  delete from auth.users where id in (v_victim, v_attacker);

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data, is_sso_user)
  values
    ('00000000-0000-0000-0000-000000000000', v_victim,   'authenticated', 'authenticated',
     'sec-victim@example.invalid',   crypt('x', gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{}', false),
    ('00000000-0000-0000-0000-000000000000', v_attacker, 'authenticated', 'authenticated',
     'sec-attacker@example.invalid', crypt('x', gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{}', false);

  insert into public.accounts (user_id, name) values (v_victim, 'V') returning id into v_acct_v;
  insert into public.accounts (user_id, name) values (v_attacker, 'A') returning id into v_acct_a;

  insert into public.products (user_id, sector_id, name, normalized_name)
    values (v_victim, v_food, 'Cha', 'cha') returning id into v_prod_v;
  insert into public.products (user_id, sector_id, name, normalized_name)
    values (v_attacker, v_food, 'Tea', 'tea') returning id into v_prod_a;
  insert into public.products (user_id, sector_id, name, normalized_name)
    values (v_attacker, v_food, 'Teaa', 'teaa') returning id into v_prod_a2;

  insert into public.transactions (user_id, account_id, product_id, amount, direction,
                                   occurred_at, raw_description, dedup_key)
    values (v_victim, v_acct_v, v_prod_v, 10, 'debit', now(), 'Cha', 'sec-test-1')
    returning id into v_tx_v;

  -- --- 1. attacker, as `authenticated`, merges the victim's product ---------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_attacker, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.merge_products(v_prod_a, v_prod_v);
    v_err := null;
  exception when others then
    v_err := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  insert into public._saveit_sec_results (name, ok, detail)
    values ('attacker cannot merge victim product', v_err is not null, coalesce(v_err, 'MERGE SUCCEEDED'));

  select product_id into v_after from public.transactions where id = v_tx_v;
  insert into public._saveit_sec_results (name, ok, detail)
    values ('victim transaction untouched', v_after = v_prod_v, v_after::text);

  -- --- 2. the error does not reveal whether the id exists -------------------
  insert into public._saveit_sec_results (name, ok, detail)
    values ('error is indistinguishable from a missing id',
            v_err = 'one of the products does not exist', v_err);

  -- --- 3. attacker CAN merge their own two products --------------------------
  perform set_config('role', 'authenticated', true);
  begin
    perform public.merge_products(v_prod_a, v_prod_a2);
    v_err := null;
  exception when others then
    v_err := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  insert into public._saveit_sec_results (name, ok, detail)
    values ('owner can merge own products', v_err is null, coalesce(v_err, 'ok'));

  -- --- 4. even a trusted caller (no JWT) cannot merge across tenants --------
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.merge_products(v_prod_v, v_prod_a);
    v_err := null;
  exception when others then
    v_err := sqlerrm;
  end;
  insert into public._saveit_sec_results (name, ok, detail)
    values ('service context cannot merge across tenants', v_err is not null, coalesce(v_err, 'MERGE SUCCEEDED'));

  -- --- 5. privileges ---------------------------------------------------------
  insert into public._saveit_sec_results (name, ok, detail) values
    ('anon cannot execute merge_products',
     not has_function_privilege('anon', 'public.merge_products(uuid,uuid)', 'EXECUTE'), null),
    ('anon cannot execute recount_product_use_counts',
     not has_function_privilege('anon', 'public.recount_product_use_counts()', 'EXECUTE'), null),
    ('authenticated cannot execute recount_product_use_counts',
     not has_function_privilege('authenticated', 'public.recount_product_use_counts()', 'EXECUTE'), null),
    ('authenticated can still execute merge_products',
     has_function_privilege('authenticated', 'public.merge_products(uuid,uuid)', 'EXECUTE'), null);

  delete from auth.users where id in (v_victim, v_attacker);
end;
$$;

select n, name, ok, detail,
       (select count(*) from auth.users where email like 'sec-%@example.invalid') as leftover_users
from public._saveit_sec_results order by n;
