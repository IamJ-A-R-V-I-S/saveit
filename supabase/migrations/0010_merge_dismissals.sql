-- =============================================================================
-- SaveIt — 0010 : remember "these are not duplicates"
--
-- The merge queue suggests product pairs that look like spelling variants. The
-- first pass of that queue used "one normalized name is a prefix of the other"
-- as a signal, which cannot distinguish a shared word from a shared product:
-- it offered to merge Ruti into Ruti-tarka, and Kachori paratha into Kachori
-- paratha egg. Both are pairs of genuinely different foods, and both are seeded
-- as distinct products, so the suggestion was wrong on day one.
--
-- The heuristic is fixed in apps/web/lib/taxonomy-candidates.ts (prefix
-- matching is gone). This table fixes the other half: a human saying "these are
-- different" has to survive a page reload. Previously the Skip button only hid
-- the row in React state, so every visit re-raised the same rejected merge.
--
-- A dismissal is scoped to one user and one unordered pair of products.
-- products.id is stable, so the pair stays dismissed for as long as both
-- products exist; deleting a product cascades the dismissal away with it.
-- =============================================================================

create table if not exists public.product_merge_dismissals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  product_a_id  uuid not null references public.products (id) on delete cascade,
  product_b_id  uuid not null references public.products (id) on delete cascade,
  reason        text,
  created_at    timestamptz not null default now(),

  -- One canonical direction, so a pair cannot be dismissed twice as (a,b) and
  -- (b,a). The app sorts the two ids before writing; this check is the
  -- backstop for a future caller that forgets to.
  constraint product_merge_dismissals_order check (product_a_id < product_b_id)
);

-- Covers both the duplicate-prevention constraint and the read path, which
-- fetches every dismissal for the signed-in user on each taxonomy render.
create unique index if not exists product_merge_dismissals_pair_uidx
  on public.product_merge_dismissals (user_id, product_a_id, product_b_id);

-- -----------------------------------------------------------------------------
-- RLS : strictly private to the owner, like every other user-keyed table.
-- The generic loop in 0002 only covers the tables that existed then, so these
-- policies are written out explicitly.
-- -----------------------------------------------------------------------------
alter table public.product_merge_dismissals enable row level security;

create policy "product_merge_dismissals_select_own"
  on public.product_merge_dismissals for select to authenticated
  using (auth.uid() = user_id);

create policy "product_merge_dismissals_insert_own"
  on public.product_merge_dismissals for insert to authenticated
  with check (auth.uid() = user_id);

create policy "product_merge_dismissals_delete_own"
  on public.product_merge_dismissals for delete to authenticated
  using (auth.uid() = user_id);

-- No update policy: a dismissal is immutable. Un-dismissing is a delete, which
-- the UI does not expose today.

revoke all on public.product_merge_dismissals from anon;
grant select, insert, delete on public.product_merge_dismissals to authenticated;
