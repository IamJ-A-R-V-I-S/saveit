-- =============================================================================
-- SaveIt — 0011 : a dismissal may only name the caller's own products
--
-- 0010's insert policy checks `auth.uid() = user_id`, which stops a user from
-- writing a dismissal *for someone else*. It does not stop them from naming
-- someone else's product ids in a row of their own: PostgREST is reachable
-- directly, so the server action's ownership check is a convenience, not a
-- guarantee.
--
-- This is a correctness hole rather than a disclosure one -- the row is only
-- visible to its author, and no other tenant's data changes -- but the same
-- reasoning as 0009 applies: enforce it where it cannot be bypassed. An
-- application-level check is one refactor away from being forgotten.
--
-- The subqueries read `products` through the caller's RLS, so they resolve to
-- "exists and is mine" in one predicate.
-- =============================================================================

drop policy if exists "product_merge_dismissals_insert_own"
  on public.product_merge_dismissals;

create policy "product_merge_dismissals_insert_own"
  on public.product_merge_dismissals for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.products p
       where p.id = product_a_id and p.user_id = auth.uid()
    )
    and exists (
      select 1 from public.products p
       where p.id = product_b_id and p.user_id = auth.uid()
    )
  );
