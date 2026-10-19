-- =============================================================================
-- SaveIt — 0012 : one account per account
--
-- Accounts are created on first sight from the string a statement puts in its
-- account column (`ensureAccount` in _shared/db.ts). That match was a
-- case-insensitive equality on the whole name, so the sample tracker — which
-- contains both `Slice bank` (77 rows) and `Slice` (2 rows) for one account —
-- produced two accounts, and the transactions filter offered both.
--
-- The nasty detail: transactions.dedup_key embeds account_id (0004). Repointing
-- a row at another account without recomputing its key would mean the NEXT
-- upload of the same statement computes a different key and inserts a duplicate.
-- merge_accounts therefore recomputes keys, and drops rows whose recomputed key
-- already exists — those are, by definition, duplicates of a row already there.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Canonicalizer. MUST match canonicalAccountName() in
-- supabase/functions/_shared/accounts.ts.
--
-- NOTE: in Postgres regular expressions `\b` is a BACKSPACE, not a word
-- boundary (that is `\y`), so the `a/c` and `acct` rewrites below are inert for
-- ordinary names: 'A/C Slice' canonicalizes to 'a c slice', not 'slice'. They
-- are kept because this migration is already applied; the TypeScript mirrors
-- the behaviour that is actually deployed, and scripts/test-accounts.mjs pins
-- it. Changing either side alone would make ensureAccount miss the row it just
-- inserted and split the account again.
-- -----------------------------------------------------------------------------
create or replace function public.canonical_account_name(raw text)
returns text
language plpgsql
immutable
as $$
declare
  t text;
begin
  t := lower(coalesce(raw, ''));
  t := regexp_replace(t, '\ba/c\b', ' ', 'g');
  t := regexp_replace(t, '\bacct\b', ' ', 'g');
  t := regexp_replace(t, '[^a-z0-9]+', ' ', 'g');
  t := btrim(t);

  -- Drop trailing generic words ("Slice bank" -> "slice"), but never empty the
  -- name out: an account genuinely called "Bank" keeps it.
  while t ~ '\s(bank|account|ac)$' loop
    t := regexp_replace(t, '\s(bank|account|ac)$', '');
  end loop;

  return t;
end;
$$;

-- -----------------------------------------------------------------------------
-- Column + backfill
-- -----------------------------------------------------------------------------
alter table public.accounts
  add column if not exists normalized_name text not null default '';

update public.accounts
   set normalized_name = public.canonical_account_name(name)
 where normalized_name is distinct from public.canonical_account_name(name);

-- A trigger, not application code: accounts are written by edge functions (with
-- the service role), by the web app's server actions, and by hand from the SQL
-- editor. One of those would eventually forget, and a stale normalized_name
-- silently splits an account in two again.
create or replace function public.set_account_normalized_name()
returns trigger
language plpgsql
as $$
begin
  new.normalized_name := public.canonical_account_name(new.name);
  return new;
end;
$$;

drop trigger if exists accounts_normalized_name on public.accounts;
create trigger accounts_normalized_name
  before insert or update of name on public.accounts
  for each row execute function public.set_account_normalized_name();

-- Deliberately NOT unique. Two rows can already fold to the same key in a
-- tenant that predates this migration (that is the bug being fixed), and a
-- unique index would make the migration fail on exactly the data it is meant to
-- let the user clean up. `ensureAccount` prefers an existing row, and
-- merge_accounts is how a human collapses the rest.
create index if not exists accounts_user_norm_idx
  on public.accounts (user_id, normalized_name)
  where not is_archived;

-- -----------------------------------------------------------------------------
-- merge_accounts : collapse two accounts that are the same account.
-- -----------------------------------------------------------------------------
create or replace function public.merge_accounts(
  p_keep_id uuid,
  p_drop_id uuid
)
returns integer
language plpgsql
-- pgcrypto lives in `extensions` on Supabase and make_dedup_key() calls
-- digest() unqualified. With `search_path = public` alone this function raises
-- `function digest(text, unknown) does not exist` the first time it runs.
security definer set search_path = public, extensions
as $$
declare
  v_caller    uuid := auth.uid();
  v_keep_user uuid;
  v_drop_user uuid;
  v_moved     integer := 0;
begin
  if p_keep_id is null or p_drop_id is null then
    raise exception 'both account ids are required';
  end if;

  if p_keep_id = p_drop_id then
    raise exception 'cannot merge an account into itself';
  end if;

  select user_id into v_keep_user
    from public.accounts where id = p_keep_id and not is_archived for update;
  select user_id into v_drop_user
    from public.accounts where id = p_drop_id and not is_archived for update;

  if v_keep_user is null or v_drop_user is null
     or (v_caller is not null and (v_keep_user <> v_caller or v_drop_user <> v_caller)) then
    raise exception 'one of the accounts does not exist';
  end if;

  if v_keep_user <> v_drop_user then
    raise exception 'cannot merge accounts that belong to different users';
  end if;

  -- 1. Drop true duplicates. A row is a duplicate if its recomputed key already
  --    exists under the surviving account, or if two moving rows compute the
  --    same key (identical to the second, same description).
  with candidates as (
    select
      t.id,
      public.make_dedup_key(
        t.user_id, p_keep_id, t.occurred_at, t.amount,
        coalesce(t.raw_description, ''), 0
      ) as new_key,
      row_number() over (
        partition by public.make_dedup_key(
          t.user_id, p_keep_id, t.occurred_at, t.amount,
          coalesce(t.raw_description, ''), 0
        )
        order by t.created_at, t.id
      ) as rn
    from public.transactions t
    where t.account_id = p_drop_id
      and t.user_id = v_keep_user
  ),
  doomed as (
    select c.id
    from candidates c
    where c.rn > 1
       or exists (
         select 1 from public.transactions x
         where x.user_id = v_keep_user
           and x.dedup_key = c.new_key
       )
  )
  delete from public.transactions t
   using doomed d
   where t.id = d.id;

  -- 2. Move the rest, recomputing the key because it embeds account_id.
  with candidates as (
    select
      t.id,
      public.make_dedup_key(
        t.user_id, p_keep_id, t.occurred_at, t.amount,
        coalesce(t.raw_description, ''), 0
      ) as new_key
    from public.transactions t
    where t.account_id = p_drop_id
      and t.user_id = v_keep_user
  )
  update public.transactions t
     set account_id = p_keep_id,
         dedup_key  = c.new_key
    from candidates c
   where t.id = c.id;

  get diagnostics v_moved = row_count;

  -- Documents that were uploaded against the losing account follow it.
  update public.documents
     set account_id = p_keep_id
   where account_id = p_drop_id
     and user_id = v_keep_user;

  -- Archive, never delete: transactions.account_id is ON DELETE CASCADE, so a
  -- delete here would silently take any row this function failed to move.
  update public.accounts
     set is_archived = true,
         updated_at  = now()
   where id = p_drop_id;

  return v_moved;
end;
$$;

revoke execute on function public.merge_accounts(uuid, uuid) from public, anon;
grant  execute on function public.merge_accounts(uuid, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- v_account_usage : how much each account actually holds.
-- security_invoker so the caller's RLS applies to accounts and transactions.
-- -----------------------------------------------------------------------------
create or replace view public.v_account_usage
with (security_invoker = true) as
select
  a.id   as account_id,
  a.user_id,
  a.name,
  a.kind,
  a.is_archived,
  count(t.id)::integer as txn_count,
  coalesce(sum(case when t.direction = 'debit'  then t.amount end), 0) as spend,
  coalesce(sum(case when t.direction = 'credit' then t.amount end), 0) as income,
  min(t.occurred_at) as first_seen,
  max(t.occurred_at) as last_seen
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id, a.user_id, a.name, a.kind, a.is_archived;

grant select on public.v_account_usage to authenticated;
revoke all on public.v_account_usage from anon;
