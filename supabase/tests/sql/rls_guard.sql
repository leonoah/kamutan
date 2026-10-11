-- CI guard: fails (raises) if any table in schema public lacks RLS, FORCE RLS,
-- at least one policy, a NOT NULL org_id (tenant tables), or leaks privileges to anon.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sql/rls_guard.sql
do $$
declare
  v_problems text;
begin
  select string_agg(table_name || ': ' || problem, E'\n')
    into v_problems
  from app.rls_coverage_report();
  if v_problems is not null then
    raise exception E'RLS coverage guard failed:\n%', v_problems;
  end if;
end $$;
