-- 0009: RLS coverage guard (SEC-06). CI runs:
--   select * from app.rls_coverage_report();   -- must return zero rows
-- (see supabase/tests/sql/rls_guard.sql which raises if it does not).

create or replace function app.rls_coverage_report()
returns table (table_name text, problem text)
language sql stable set search_path = '' as $$
  with t as (
    select c.oid, c.relname::text as relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      -- tables owned by an extension are not ours to police
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_class'::regclass
                        and d.objid = c.oid and d.deptype = 'e')
  )
  select relname, 'rls_disabled' from t where not relrowsecurity
  union all
  select relname, 'rls_not_forced' from t where not relforcerowsecurity
  union all
  select relname, 'no_policy' from t
  where not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = t.oid)
  union all
  select relname, 'anon_has_privileges' from t
  where exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'anon')
    and (has_table_privilege('anon', t.oid, 'SELECT')
         or has_table_privilege('anon', t.oid, 'INSERT')
         or has_table_privilege('anon', t.oid, 'UPDATE')
         or has_table_privilege('anon', t.oid, 'DELETE'))
  union all
  select relname, 'missing_org_id' from t
  where relname not in ('orgs', 'profiles')
    and not exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = t.oid and a.attname = 'org_id'
                      and a.attnotnull and not a.attisdropped)
  order by 1, 2
$$;

revoke all on function app.rls_coverage_report() from public;
