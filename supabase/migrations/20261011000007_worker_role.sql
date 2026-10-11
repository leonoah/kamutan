-- 0007: privileges and RLS policies of the pipeline worker role (SEC-24, decision #3).
--
-- kamutan_worker:
--   * is NOT service_role and does NOT bypass RLS;
--   * can touch only pipeline tables (below) — no memberships, share_links,
--     audit_log, BOQ, orgs, profiles;
--   * sees/writes only rows whose org_id = current_setting('kamutan.org_id'),
--     which the worker sets per transaction from the job it is processing.
--     (This is a guard against cross-tenant mistakes, not against a fully
--     compromised worker, which could set any org id — see NOTES.md.)

revoke all on all tables in schema public from kamutan_worker;

-- sheet_versions: read + update processing status/results only
grant select on public.sheet_versions to kamutan_worker;
grant update (status, pipeline_state, width_mm, height_mm, scale, scale_source, scale_conflict,
              is_raster, tiles_manifest_path, title_block, updated_at)
  on public.sheet_versions to kamutan_worker;

-- pipeline outputs: read / insert / update (re-runs supersede, they do not delete)
grant select, insert, update on
  public.legends, public.legend_entries, public.symbol_templates,
  public.detections, public.rooms, public.links
  to kamutan_worker;

-- jobs: read + progress/status reporting
grant select on public.jobs to kamutan_worker;
grant update (status, progress, stage, attempts, error, cost_usd, started_at, finished_at, updated_at)
  on public.jobs to kamutan_worker;

do $$
declare
  t text;
begin
  foreach t in array array[
    'sheet_versions', 'legends', 'legend_entries', 'symbol_templates',
    'detections', 'rooms', 'links', 'jobs'
  ] loop
    execute format(
      'create policy %I on public.%I for all to kamutan_worker '
      'using (org_id = app.worker_org_id()) with check (org_id = app.worker_org_id())',
      t || '_worker', t);
  end loop;
end $$;
