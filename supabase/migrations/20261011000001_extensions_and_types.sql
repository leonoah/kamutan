-- 0001: schemas, extensions, enum types, generic helpers, worker role.
-- Coordinates convention for every geometry column in this schema:
--   SRID 0, units = paper millimetres, origin = top-left of the sheet, y grows DOWN.

create schema if not exists extensions;
create schema if not exists app;

-- PostGIS / pgcrypto live in `extensions` (Supabase convention) so that
-- PostGIS's `spatial_ref_sys` table does not land in `public` (the RLS guard
-- requires every table in public to have RLS).
create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis  with schema extensions;

revoke all on schema app from public;
grant usage on schema app to authenticated;
grant usage on schema extensions to authenticated;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
create type public.member_role         as enum ('admin', 'editor', 'reviewer', 'viewer');
create type public.sheet_version_status as enum ('uploaded', 'queued', 'processing', 'ready', 'failed');
create type public.confidence_level    as enum ('green', 'yellow', 'red');
create type public.detection_status    as enum ('auto', 'accepted', 'rejected', 'edited');
create type public.entity_source       as enum ('auto', 'manual');
create type public.lifecycle_kind      as enum ('existing', 'new', 'demolish');
create type public.supply_kind         as enum ('contractor', 'client', 'existing');
create type public.legend_scope        as enum ('sheet', 'set');
create type public.template_source     as enum ('legend', 'dxf_block', 'manual', 'learned');
create type public.mapping_key_type    as enum ('template_hash', 'block_name', 'pattern');
create type public.boq_line_status     as enum ('draft', 'reviewed', 'approved');
create type public.link_status         as enum ('auto', 'accepted', 'rejected', 'edited');
create type public.job_status          as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.actor_kind          as enum ('user', 'system', 'share', 'worker');

-- ---------------------------------------------------------------------------
-- Generic helpers (no table dependencies)
-- ---------------------------------------------------------------------------

-- updated_at maintenance
create or replace function app.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Safe text -> uuid (NULL instead of an error); used by storage policies.
create or replace function app.try_uuid(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- True when the current DB role is an end-user API role, i.e. RLS-governed
-- business rules (approval rights etc.) must be enforced in triggers.
-- ONLY meaningful in SECURITY INVOKER code: inside a SECURITY DEFINER function
-- current_user is the function owner.
create or replace function app.is_end_user() returns boolean
language sql stable set search_path = '' as $$
  select current_user in ('authenticated', 'anon')
$$;

-- The org the pipeline worker is currently processing. The worker MUST run
--   select set_config('kamutan.org_id', '<job org uuid>', true);
-- at the start of every transaction; kamutan_worker policies only expose rows
-- of that org (SEC-24: every write must carry the job's org_id).
create or replace function app.worker_org_id() returns uuid
language sql stable set search_path = '' as $$
  select app.try_uuid(nullif(current_setting('kamutan.org_id', true), ''))
$$;

-- ---------------------------------------------------------------------------
-- Dedicated, limited pipeline-worker role (decision #3 in 08_workplan_v2 §2).
-- NOLOGIN here; ops creates a LOGIN role that is a member of it, e.g.
--   create role kamutan_worker_login login password '...' in role kamutan_worker;
-- Not BYPASSRLS, not a member of authenticated/service_role.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kamutan_worker') then
    create role kamutan_worker nologin noinherit nobypassrls;
  end if;
end $$;

grant usage on schema app to kamutan_worker;
grant usage on schema extensions to kamutan_worker;
grant execute on function app.worker_org_id() to kamutan_worker;
grant execute on function app.try_uuid(text) to kamutan_worker;
