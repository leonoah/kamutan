-- 0006: Row Level Security for every public table + grants for API roles.
--
-- Role matrix (end users, role `authenticated`):
--   viewer   : read everything in their org (except share_links, audit_log)
--   reviewer : viewer + correct detections/links, approve BOQ lines
--   editor   : write project data, BOQ content (not approval)
--   admin    : everything + memberships, org settings, audit log
-- `anon` gets nothing: external share viewing goes through the API (decision #6).

-- ---------------------------------------------------------------------------
-- Enable + FORCE RLS on every table in public, and freeze org_id on update.
-- ---------------------------------------------------------------------------
create or replace function app.org_id_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception '%.org_id is immutable', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('alter table public.%I force row level security', t.relname);
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = t.relname and column_name = 'org_id')
       and t.relname not in ('audit_log', 'memberships')
    then
      execute format(
        'create trigger %I before update on public.%I for each row execute function app.org_id_immutable()',
        t.relname || '_org_id_immutable', t.relname);
    end if;
  end loop;
end $$;

-- updated_at triggers for the tables created in 0003-0005
do $$
declare
  t text;
begin
  foreach t in array array[
    'projects', 'project_floors', 'sheet_sets', 'sheets', 'sheet_versions', 'sheet_regions',
    'legends', 'legend_entries', 'symbol_templates', 'rooms', 'detections', 'links', 'jobs',
    'boq_templates', 'item_library', 'symbol_item_mappings', 'boq_lines', 'boq_line_evidence',
    'share_links'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function app.set_updated_at()',
      t || '_updated_at', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Standard tenant tables: read = any member; write per role list.
-- ---------------------------------------------------------------------------
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      --  table                   insert roles                         update roles                         delete roles
      ('projects',             array['admin','editor'],             array['admin','editor'],             array['admin']),
      ('project_floors',       array['admin','editor'],             array['admin','editor'],             array['admin','editor']),
      ('sheet_sets',           array['admin','editor'],             array['admin','editor'],             array['admin']),
      ('sheets',               array['admin','editor'],             array['admin','editor'],             array[]::text[]),  -- FR-02: no physical delete
      ('sheet_versions',       array['admin','editor'],             array['admin','editor'],             array[]::text[]),
      ('sheet_regions',        array['admin','editor'],             array['admin','editor'],             array['admin','editor']),
      ('legends',              array['admin','editor'],             array['admin','editor'],             array['admin','editor']),
      ('legend_entries',       array['admin','editor'],             array['admin','editor'],             array['admin','editor']),
      ('symbol_templates',     array['admin','editor'],             array['admin','editor'],             array['admin','editor']),
      ('rooms',                array['admin','editor'],             array['admin','editor'],             array['admin','editor']),
      ('detections',           array['admin','editor','reviewer'],  array['admin','editor','reviewer'],  array[]::text[]),  -- reject, don't delete
      ('links',                array['admin','editor','reviewer'],  array['admin','editor','reviewer'],  array[]::text[]),
      ('jobs',                 array['admin','editor'],             array['admin','editor'],             array[]::text[]),
      ('item_library',         array['admin','editor'],             array['admin','editor'],             array['admin']),
      ('boq_templates',        array['admin','editor'],             array['admin','editor'],             array['admin']),
      ('symbol_item_mappings', array['admin','editor','reviewer'],  array['admin','editor','reviewer'],  array['admin']),
      ('boq_lines',            array['admin','editor'],             array['admin','editor','reviewer'],  array['admin','editor']),
      ('boq_line_evidence',    array['admin','editor'],             array['admin','editor'],             array['admin','editor'])
    ) as s(tbl, ins, upd, del)
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', spec.tbl);

    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_member(org_id))',
      spec.tbl || '_select', spec.tbl);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (app.has_role(org_id, %L::text[]))',
      spec.tbl || '_insert', spec.tbl, spec.ins);
    execute format(
      'create policy %I on public.%I for update to authenticated using (app.has_role(org_id, %L::text[])) with check (app.has_role(org_id, %L::text[]))',
      spec.tbl || '_update', spec.tbl, spec.upd, spec.upd);
    if cardinality(spec.del) > 0 then
      execute format(
        'create policy %I on public.%I for delete to authenticated using (app.has_role(org_id, %L::text[])%s)',
        spec.tbl || '_delete', spec.tbl, spec.del,
        case when spec.tbl = 'boq_lines' then ' and status = ''draft''' else '' end);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- orgs: members read; admins update; creation only via app.create_org().
-- ---------------------------------------------------------------------------
grant select on public.orgs to authenticated;
grant update (name, settings) on public.orgs to authenticated;
create policy orgs_select on public.orgs for select to authenticated
  using (app.is_member(id));
create policy orgs_update on public.orgs for update to authenticated
  using (app.has_role(id, array['admin'])) with check (app.has_role(id, array['admin']));

-- ---------------------------------------------------------------------------
-- profiles: own row, plus read profiles of people sharing an org.
-- ---------------------------------------------------------------------------
grant select, insert, update on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or app.shares_org_with(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- memberships: members see the roster; only admins manage it.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.memberships to authenticated;
create policy memberships_select on public.memberships for select to authenticated
  using (app.is_member(org_id));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (app.has_role(org_id, array['admin']));
create policy memberships_update on public.memberships for update to authenticated
  using (app.has_role(org_id, array['admin'])) with check (app.has_role(org_id, array['admin']));
create policy memberships_delete on public.memberships for delete to authenticated
  using (app.has_role(org_id, array['admin']));

-- ---------------------------------------------------------------------------
-- share_links: admin/editor create, list and revoke; never deleted.
-- ---------------------------------------------------------------------------
grant select, insert, update on public.share_links to authenticated;
create policy share_links_select on public.share_links for select to authenticated
  using (app.has_role(org_id, array['admin', 'editor']));
create policy share_links_insert on public.share_links for insert to authenticated
  with check (app.has_role(org_id, array['admin', 'editor']));
create policy share_links_update on public.share_links for update to authenticated
  using (app.has_role(org_id, array['admin', 'editor']))
  with check (app.has_role(org_id, array['admin', 'editor']));

-- ---------------------------------------------------------------------------
-- audit_log: admins read their org's log. No INSERT/UPDATE/DELETE policy:
-- rows are written only by SECURITY DEFINER functions/triggers.
-- ---------------------------------------------------------------------------
grant select on public.audit_log to authenticated;
create policy audit_log_select_admin on public.audit_log for select to authenticated
  using (app.has_role(org_id, array['admin']));

-- Defence in depth: no API role can modify audit rows even if a policy is added later.
revoke insert, update, delete, truncate on public.audit_log from authenticated, anon, public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke update, delete, truncate on public.audit_log from service_role;
  end if;
end $$;

-- anon has no business in public (share links go through the API).
revoke all on all tables in schema public from anon;

-- Helper functions used inside policies/triggers
grant execute on function app.is_end_user(), app.try_uuid(text), app.worker_org_id() to authenticated;
