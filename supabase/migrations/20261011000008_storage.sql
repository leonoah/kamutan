-- 0008: private bucket `drawings` + storage.objects policies by org prefix.
-- Object names MUST start with '<org_id>/' (e.g. '<org_id>/<project_id>/<sha256>.pdf').
-- Guarded so the migration chain also runs on a plain Postgres without Supabase Storage.

do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present; skipping storage policies';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('drawings', 'drawings', false)
  on conflict (id) do update set public = false;

  execute 'drop policy if exists kamutan_drawings_select on storage.objects';
  execute 'drop policy if exists kamutan_drawings_insert on storage.objects';
  execute 'drop policy if exists kamutan_drawings_update on storage.objects';
  execute 'drop policy if exists kamutan_drawings_delete on storage.objects';

  execute $p$
    create policy kamutan_drawings_select on storage.objects for select to authenticated
    using (bucket_id = 'drawings'
           and app.is_member(app.try_uuid(split_part(name, '/', 1))))
  $p$;
  execute $p$
    create policy kamutan_drawings_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'drawings'
                and app.has_role(app.try_uuid(split_part(name, '/', 1)), array['admin', 'editor']))
  $p$;
  execute $p$
    create policy kamutan_drawings_update on storage.objects for update to authenticated
    using (bucket_id = 'drawings'
           and app.has_role(app.try_uuid(split_part(name, '/', 1)), array['admin', 'editor']))
    with check (bucket_id = 'drawings'
                and app.has_role(app.try_uuid(split_part(name, '/', 1)), array['admin', 'editor']))
  $p$;
  execute $p$
    create policy kamutan_drawings_delete on storage.objects for delete to authenticated
    using (bucket_id = 'drawings'
           and app.has_role(app.try_uuid(split_part(name, '/', 1)), array['admin']))
  $p$;
end $$;
