-- =============================================================================
-- SaveIt — 0008 : maintain products.use_count
--
-- use_count drives the ordering of the taxonomy brief sent to the categorizer:
-- listing the products this user actually buys most, first, raises the chance
-- the model reuses an existing name instead of inventing a near-duplicate. It is
-- also what makes findNearDuplicates() and the merge queue worth running.
--
-- These are STATEMENT-level triggers with transition tables, not row-level. A
-- single import inserts ~5,500 rows; a row-level trigger would issue ~5,500
-- extra UPDATE statements against `products`, which is the difference between a
-- two-second import and a thirty-second one. Aggregating the transition table
-- turns that into one UPDATE per distinct product.
-- =============================================================================

create or replace function public.maintain_product_use_count()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- A plain UPDATE, not INSERT .. ON CONFLICT DO UPDATE. The upsert form
    -- validates the candidate INSERT row first, so supplying only
    -- (id, use_count) trips the NOT NULL constraints on user_id / sector_id /
    -- name even though the row already exists and the DO UPDATE branch is the
    -- one that would run. The FK on transactions.product_id already guarantees
    -- the product exists, so there is nothing to insert.
    update public.products p
       set use_count = p.use_count + d.n
      from (
        select product_id, count(*) as n
        from new_rows
        where product_id is not null
        group by product_id
      ) d
     where p.id = d.product_id;

  elsif tg_op = 'DELETE' then
    update public.products p
       set use_count = greatest(0, p.use_count - d.n)
      from (
        select product_id, count(*) as n
        from old_rows
        where product_id is not null
        group by product_id
      ) d
     where p.id = d.product_id;

  elsif tg_op = 'UPDATE' then
    -- Only rows whose product actually changed affect any counter. A bulk
    -- correction that repoints 400 rows at one product is one UPDATE here,
    -- not 400.
    update public.products p
       set use_count = greatest(0, p.use_count - d.n)
      from (
        select o.product_id, count(*) as n
        from old_rows o
        join new_rows nw on nw.id = o.id
        where o.product_id is not null
          and o.product_id is distinct from nw.product_id
        group by o.product_id
      ) d
     where p.id = d.product_id;

    update public.products p
       set use_count = p.use_count + d.n
      from (
        select nw.product_id, count(*) as n
        from new_rows nw
        join old_rows o on o.id = nw.id
        where nw.product_id is not null
          and o.product_id is distinct from nw.product_id
        group by nw.product_id
      ) d
     where p.id = d.product_id;
  end if;

  return null;  -- statement-level AFTER trigger: return value is ignored
end;
$$;

drop trigger if exists use_count_insert on public.transactions;
create trigger use_count_insert
  after insert on public.transactions
  referencing new table as new_rows
  for each statement execute function public.maintain_product_use_count();

drop trigger if exists use_count_delete on public.transactions;
create trigger use_count_delete
  after delete on public.transactions
  referencing old table as old_rows
  for each statement execute function public.maintain_product_use_count();

-- No column list here: Postgres rejects transition tables on a trigger declared
-- `AFTER UPDATE OF <col>` ("transition tables cannot be specified for triggers
-- with column lists"). The function body already filters on
-- `old.product_id IS DISTINCT FROM new.product_id`, so updates that do not move
-- a transaction between products aggregate to nothing and cost one no-op
-- statement.
drop trigger if exists use_count_update on public.transactions;
create trigger use_count_update
  after update on public.transactions
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.maintain_product_use_count();

-- -----------------------------------------------------------------------------
-- Backfill / repair. Idempotent; safe to re-run at any time.
-- -----------------------------------------------------------------------------
create or replace function public.recount_product_use_counts()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  n integer;
begin
  with actual as (
    select p.id, count(t.id)::integer as c
    from public.products p
    left join public.transactions t on t.product_id = p.id
    group by p.id
  )
  update public.products p
     set use_count = a.c
    from actual a
   where p.id = a.id
     and p.use_count is distinct from a.c;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.recount_product_use_counts() from public;
grant execute on function public.recount_product_use_counts() to authenticated, service_role;

select public.recount_product_use_counts();
