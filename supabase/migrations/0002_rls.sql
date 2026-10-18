-- =============================================================================
-- SaveIt — 0002 : row level security
--
-- Every user-scoped table is isolated by auth.uid(). Edge functions run with
-- the service-role key, which bypasses RLS — that is deliberate: the agents
-- need to read a user's whole history to categorize and to compute trends.
--
-- Policies are generated in a loop rather than hand-written per table. Nine
-- owner-keyed tables x three CRUD verbs is ~27 near-identical statements, which
-- is exactly where a mismatched `using` / `with check` pair hides. One
-- generator, one shape, no drift. The three tables with a different ownership
-- shape -- profiles (keyed on id), aliases (own + global), sectors (global
-- read-only) -- are written out explicitly below.
-- =============================================================================

-- Tables that are strictly private to their owner, keyed on a `user_id` column.
-- NOTE: `profiles` is deliberately absent -- its owner column is `id`
-- (== auth.users.id), not `user_id`, so it gets bespoke policies below.
do $$
declare
  t text;
begin
  foreach t in array array[
    'products', 'accounts', 'documents',
    'transactions', 'corrections', 'insights', 'budgets', 'goals', 'llm_usage'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (auth.uid() = user_id)',
      t || '_delete_own', t);
  end loop;
end;
$$;

-- Inserts need `with check` (there is no existing row to test `using` against).
-- profiles is keyed on `id`, not `user_id`, so it gets its own shape and is
-- excluded from the loop above for inserts.
do $$
declare
  t text;
begin
  foreach t in array array[
    'products', 'accounts', 'documents', 'transactions',
    'corrections', 'insights', 'budgets', 'goals'
  ] loop
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (auth.uid() = user_id)',
      t || '_insert_own', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles : keyed on id (== auth.users.id). A user can read and update their
-- own row, and may create it (idempotent with the signup trigger), but there is
-- deliberately no delete policy -- the FK cascade from auth.users owns that.
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

create policy "profiles_insert_self"
  on public.profiles for insert to authenticated
  with check (auth.uid() = id);

-- -----------------------------------------------------------------------------
-- llm_usage : append-only from the client's perspective. Only edge functions
-- (service role) write to it, so there is deliberately no insert/update policy
-- for authenticated users.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- aliases : own rules, plus global rules (user_id is null) so shared merchant
-- knowledge is readable by everyone but writable only by its owner.
-- -----------------------------------------------------------------------------
alter table public.aliases enable row level security;

create policy "aliases_select_own_and_global"
  on public.aliases for select to authenticated
  using (user_id = auth.uid() or user_id is null);

create policy "aliases_insert_own"
  on public.aliases for insert to authenticated
  with check (auth.uid() = user_id);

create policy "aliases_update_own"
  on public.aliases for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "aliases_delete_own"
  on public.aliases for delete to authenticated
  using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- sectors : the FIXED global taxonomy. Readable by every authenticated user,
-- writable by nobody but the service role (migrations seed it).
-- Without a select policy, RLS would hide the taxonomy from the app entirely.
-- -----------------------------------------------------------------------------
alter table public.sectors enable row level security;

create policy "sectors_select_all_authenticated"
  on public.sectors for select to authenticated
  using (true);
