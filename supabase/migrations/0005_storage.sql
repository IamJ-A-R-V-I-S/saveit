-- =============================================================================
-- SaveIt — 0005 : storage bucket for uploaded statements
--
-- Layout: statements/{user_id}/{document_id}/{filename}
-- The user_id prefix is what makes the RLS-style policies below work: a user can
-- only read/write under their own folder.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'statements',
  'statements',
  false,
  25 * 1024 * 1024,   -- 25 MB: a year of CSV or a fat scanned PDF
  array[
    'text/csv', 'text/plain', 'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
    'application/json',
    'image/png', 'image/jpeg'   -- photographed receipts / scanned pages
  ]
)
on conflict (id) do nothing;

-- Users may manage only their own folder. `(storage.foldername(name))[1]` is the
-- first path segment, i.e. the user id.
drop policy if exists "statements_select_own" on storage.objects;
create policy "statements_select_own"
  on storage.objects for select to authenticated
  using (bucket_id = 'statements' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "statements_insert_own" on storage.objects;
create policy "statements_insert_own"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'statements' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "statements_update_own" on storage.objects;
create policy "statements_update_own"
  on storage.objects for update to authenticated
  using (bucket_id = 'statements' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "statements_delete_own" on storage.objects;
create policy "statements_delete_own"
  on storage.objects for delete to authenticated
  using (bucket_id = 'statements' and (storage.foldername(name))[1] = auth.uid()::text);
