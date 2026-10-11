-- 0003: projects, drawing sets/sheets/versions, and pipeline output tables.
--
-- Tenant integrity: every parent table exposes UNIQUE (id, org_id) and every
-- child references it with a COMPOSITE foreign key (parent_id, org_id). FK
-- checks bypass RLS, so without this a user of org A could attach rows to a
-- parent owned by org B just by knowing its uuid.
--
-- Geometry: extensions.geometry(..., 0) = paper millimetres, y down.

create table public.projects (
  id                         uuid primary key default gen_random_uuid(),
  org_id                     uuid not null references public.orgs (id) on delete cascade,
  name                       text not null check (length(btrim(name)) > 0),
  address                    text,
  status                     text not null default 'active'
                               check (status in ('active', 'archived', 'deleted')),
  boq_template_id            uuid,  -- FK added in 0004
  default_cladding_height_m  numeric(6, 3),
  created_by                 uuid references auth.users (id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (id, org_id)
);
create index projects_org_idx on public.projects (org_id);

-- Floor metadata of a project (codes referenced by sheets / regions / lines).
create table public.project_floors (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  project_id  uuid not null,
  code        text not null,             -- e.g. 'G', '1', 'R'
  name        text not null,             -- e.g. 'קומת קרקע'
  sort_order  int  not null default 0,
  elevation_m numeric(8, 3),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (project_id, code),
  foreign key (project_id, org_id) references public.projects (id, org_id) on delete cascade
);

create table public.sheet_sets (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  project_id       uuid not null,
  name             text not null,
  uploaded_by      uuid references auth.users (id) on delete set null,
  source_file_path text,
  source_sha256    text check (source_sha256 ~ '^[0-9a-f]{64}$'),
  file_kind        text not null default 'pdf' check (file_kind in ('pdf', 'dwg', 'dxf', 'image')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (project_id, org_id) references public.projects (id, org_id) on delete cascade
);

create table public.sheets (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  project_id    uuid not null,
  sheet_set_id  uuid,
  logical_key   text not null,          -- sheet number; links versions together
  discipline    text[] not null default '{}',
  floor         text,
  title         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  unique (project_id, logical_key),
  foreign key (project_id, org_id)   references public.projects (id, org_id) on delete cascade,
  foreign key (sheet_set_id, org_id) references public.sheet_sets (id, org_id) on delete set null (sheet_set_id)
);

create table public.sheet_versions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null,
  sheet_id             uuid not null,
  version_no           int  not null check (version_no > 0),
  source_sha256        text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path         text not null,     -- '<org_id>/...' inside bucket `drawings`
  page_index           int  not null default 0 check (page_index >= 0),
  status               public.sheet_version_status not null default 'uploaded',
  width_mm             numeric(10, 3),
  height_mm            numeric(10, 3),
  scale                numeric(10, 4),    -- 50 means 1:50
  scale_source         text,
  scale_conflict       boolean not null default false,
  is_raster            boolean not null default false,
  tiles_manifest_path  text,
  pipeline_state       jsonb not null default '{}'::jsonb,
  title_block          jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, org_id),
  unique (sheet_id, version_no),
  check (storage_path like org_id::text || '/%'),
  foreign key (sheet_id, org_id) references public.sheets (id, org_id) on delete cascade
);
create index sheet_versions_sha_idx on public.sheet_versions (org_id, source_sha256, page_index);

-- A sheet can contain several floors / scales (decision #10).
create table public.sheet_regions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  sheet_version_id uuid not null,
  floor            text,
  scale            numeric(10, 4),
  polygon          extensions.geometry(Polygon, 0) not null,
  label            text,
  source           public.entity_source not null default 'auto',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (sheet_version_id, org_id) references public.sheet_versions (id, org_id) on delete cascade
);
create index sheet_regions_geom_idx on public.sheet_regions using gist (polygon);

create table public.legends (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  sheet_version_id uuid not null,
  scope            public.legend_scope not null default 'sheet',
  kind             text,                 -- electrical / lighting / walls
  geom             extensions.geometry(Polygon, 0),
  parse_conf       numeric(5, 4) check (parse_conf between 0 and 1),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (sheet_version_id, org_id) references public.sheet_versions (id, org_id) on delete cascade
);

create table public.legend_entries (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  legend_id         uuid not null,
  row_index         int  not null,
  description       text,
  mount_height      text,
  fixture_type      text,
  template_hash     text,
  template_geometry extensions.geometry(Geometry, 0),
  conf              numeric(5, 4) check (conf between 0 and 1),
  confusable_with   uuid[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, org_id),
  unique (legend_id, row_index),
  foreign key (legend_id, org_id) references public.legends (id, org_id) on delete cascade
);

create table public.symbol_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  project_id    uuid,
  source        public.template_source not null,
  name          text not null,
  template_hash text,
  geometry      extensions.geometry(Geometry, 0),
  anchor        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (project_id, org_id) references public.projects (id, org_id) on delete cascade
);

create table public.rooms (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  sheet_version_id uuid not null,
  floor            text,
  geom             extensions.geometry(Polygon, 0) not null,
  name             text,
  name_conf        numeric(5, 4) check (name_conf between 0 and 1),
  area_m2          numeric(12, 3),
  perimeter_m      numeric(12, 3),
  closed           boolean not null default true,
  source           public.entity_source not null default 'auto',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (sheet_version_id, org_id) references public.sheet_versions (id, org_id) on delete cascade
);
create index rooms_geom_idx on public.rooms using gist (geom);

create table public.detections (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  sheet_version_id uuid not null,
  geom             extensions.geometry(Geometry, 0) not null,  -- point or polygon, paper mm y-down
  class            text not null,
  template_id      uuid,
  legend_entry_id  uuid,
  rotation         numeric(7, 3),
  primitive_ids    int[],
  room_id          uuid,
  score_raw        numeric,
  confidence       numeric(5, 4) not null check (confidence between 0 and 1),
  level            public.confidence_level not null,
  reasons          text[] not null default '{}',
  features         jsonb,
  status           public.detection_status not null default 'auto',
  source           public.entity_source not null default 'auto',
  lifecycle        public.lifecycle_kind not null default 'new',
  supply           public.supply_kind not null default 'contractor',
  run_id           uuid,
  superseded_by    uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (sheet_version_id, org_id) references public.sheet_versions (id, org_id) on delete cascade,
  foreign key (template_id, org_id)      references public.symbol_templates (id, org_id) on delete set null (template_id),
  foreign key (legend_entry_id, org_id)  references public.legend_entries (id, org_id) on delete set null (legend_entry_id),
  foreign key (room_id, org_id)          references public.rooms (id, org_id) on delete set null (room_id),
  foreign key (superseded_by, org_id)    references public.detections (id, org_id) on delete set null (superseded_by)
);
create index detections_geom_idx on public.detections using gist (geom);
create index detections_sv_idx   on public.detections (sheet_version_id, class);

create table public.links (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  sheet_version_id  uuid not null,
  from_detection_id uuid not null,
  to_detection_id   uuid not null,
  path_geom         extensions.geometry(LineString, 0),
  conf              numeric(5, 4) check (conf between 0 and 1),
  status            public.link_status not null default 'auto',
  source            public.entity_source not null default 'auto',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, org_id),
  check (from_detection_id <> to_detection_id),
  foreign key (sheet_version_id, org_id)  references public.sheet_versions (id, org_id) on delete cascade,
  foreign key (from_detection_id, org_id) references public.detections (id, org_id) on delete cascade,
  foreign key (to_detection_id, org_id)   references public.detections (id, org_id) on delete cascade
);

create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  project_id       uuid not null,
  sheet_version_id uuid,
  type             text not null,
  status           public.job_status not null default 'queued',
  progress         numeric(5, 2) not null default 0 check (progress between 0 and 100),
  stage            text,
  input_hash       text,
  attempts         int not null default 0,
  error            jsonb,
  cost_usd         numeric(10, 4) not null default 0,
  created_by       uuid references auth.users (id) on delete set null,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (project_id, org_id)       references public.projects (id, org_id) on delete cascade,
  foreign key (sheet_version_id, org_id) references public.sheet_versions (id, org_id) on delete cascade
);
create index jobs_project_idx on public.jobs (project_id, created_at desc);
