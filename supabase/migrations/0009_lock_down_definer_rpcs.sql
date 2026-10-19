-- =============================================================================
-- 0009 : close two SECURITY DEFINER holes
--
-- Found while wiring the web app's "Merge" button to merge_products().
--
-- 1. merge_products(keep, drop) runs as its owner, so RLS does not apply inside
--    it -- and it never checked who owned the two products. Any signed-in user
--    who learned another user's product id could merge THEIR product into
--    their own, repointing the victim's transactions, aliases and insights at a
--    product the attacker controls. It also allowed merging two products that
--    belong to different users, even from a trusted context.
--
-- 2. Both functions were executable by `anon`. 0004/0008 ran
--    `revoke ... from public`, but Supabase's default privileges grant EXECUTE
--    to anon and authenticated EXPLICITLY on every new function in `public`,
--    and revoking from PUBLIC does not remove an explicit grant. Verified with
--    has_function_privilege('anon', ...) = true before this migration.
--
-- recount_product_use_counts() leaks nothing, but it rewrites use_count for
-- every tenant in one statement; no end user needs it, so it becomes
-- service-role only.
-- =============================================================================

create or replace function public.merge_products(
  p_keep_id uuid,
  p_drop_id uuid
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_caller    uuid := auth.uid();
  v_keep_user uuid;
  v_drop_user uuid;
begin
  if p_keep_id is null or p_drop_id is null then
    raise exception 'both product ids are required';
  end if;

  if p_keep_id = p_drop_id then
    raise exception 'cannot merge a product into itself';
  end if;

  -- Lock both rows so two concurrent merges cannot interleave.
  select user_id into v_keep_user from public.products where id = p_keep_id for update;
  select user_id into v_drop_user from public.products where id = p_drop_id for update;

  -- One message for "missing" and "not yours", so the function cannot be used
  -- to probe which product ids exist in other tenants.
  if v_keep_user is null or v_drop_user is null
     or (v_caller is not null and (v_keep_user <> v_caller or v_drop_user <> v_caller)) then
    raise exception 'one of the products does not exist';
  end if;

  -- Holds even for trusted callers with no JWT (service role, migrations):
  -- a merge must never move rows between tenants.
  if v_keep_user <> v_drop_user then
    raise exception 'cannot merge products that belong to different users';
  end if;

  -- Every update below is pinned to the owner as well as the product id.
  -- Redundant today because the ids are already proven to belong to that
  -- owner, but it keeps one missed check from turning into a cross-tenant write.
  update public.transactions set product_id = p_keep_id
   where product_id = p_drop_id and user_id = v_keep_user;
  update public.aliases set product_id = p_keep_id
   where product_id = p_drop_id and (user_id = v_keep_user or user_id is null);
  update public.corrections set old_product_id = p_keep_id
   where old_product_id = p_drop_id and user_id = v_keep_user;
  update public.corrections set new_product_id = p_keep_id
   where new_product_id = p_drop_id and user_id = v_keep_user;
  update public.insights set product_id = p_keep_id
   where product_id = p_drop_id and user_id = v_keep_user;

  update public.products
     set status = 'merged', merged_into = p_keep_id, use_count = 0
   where id = p_drop_id;

  update public.products
     set use_count = (select count(*) from public.transactions where product_id = p_keep_id)
   where id = p_keep_id;
end;
$$;

-- Explicit revokes from anon: `from public` alone is not enough on Supabase.
revoke execute on function public.merge_products(uuid, uuid) from public, anon;
grant  execute on function public.merge_products(uuid, uuid) to authenticated, service_role;

revoke execute on function public.recount_product_use_counts() from public, anon, authenticated;
grant  execute on function public.recount_product_use_counts() to service_role;
