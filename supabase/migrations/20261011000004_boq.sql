-- 0004: item library, BOQ templates, symbol->item mappings, BOQ lines + evidence.
-- Item codes are TEXT everywhere ("4.10" is not "4.1") — decision #9.

create table public.boq_templates (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs (id) on delete cascade,
  name               text not null,
  chapters           jsonb not null default '[]'::jsonb,
  columns            jsonb not null default '[]'::jsonb,
  xlsx_template_path text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, org_id)
);

alter table public.projects
  add constraint projects_boq_template_fk
  foreign key (boq_template_id, org_id) references public.boq_templates (id, org_id)
  on delete set null (boq_template_id);

create table public.item_library (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  code        text not null check (length(btrim(code)) > 0),
  chapter     text,
  description text not null,
  unit        text not null,
  tags        text[] not null default '{}',
  source_file text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, code)
);

create table public.symbol_item_mappings (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  key_type     public.mapping_key_type not null,
  key          text not null,
  item_id      uuid not null,
  accept_count int not null default 0 check (accept_count >= 0),
  reject_count int not null default 0 check (reject_count >= 0),
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, key_type, key, item_id),
  foreign key (item_id, org_id) references public.item_library (id, org_id) on delete cascade
);

create table public.boq_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  project_id        uuid not null,
  item_id           uuid,
  chapter           text,
  code              text not null,
  description       text not null,
  unit              text not null,
  quantity          numeric(14, 4) not null default 0 check (quantity >= 0),
  quantity_override numeric(14, 4) check (quantity_override >= 0),
  qty_expr          jsonb,
  floor             text,
  room_id           uuid,
  lifecycle         public.lifecycle_kind not null default 'new',
  supply            public.supply_kind not null default 'contractor',
  confidence        numeric(5, 4) check (confidence between 0 and 1),
  level             public.confidence_level,  -- = min level of its evidence items (decision #7)
  reasons           text[] not null default '{}',
  status            public.boq_line_status not null default 'draft',
  note              text,
  approved_by       uuid references auth.users (id) on delete set null,
  approved_at       timestamptz,
  locked            boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, org_id),
  check (status <> 'approved' or approved_at is not null),
  check (status = 'approved' or (approved_by is null and approved_at is null)),
  foreign key (project_id, org_id) references public.projects (id, org_id) on delete cascade,
  foreign key (item_id, org_id)    references public.item_library (id, org_id) on delete set null (item_id),
  foreign key (room_id, org_id)    references public.rooms (id, org_id) on delete set null (room_id)
);
create index boq_lines_project_idx on public.boq_lines (project_id, chapter, code);

create table public.boq_line_evidence (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  boq_line_id  uuid not null,
  detection_id uuid,
  room_id      uuid,
  link_id      uuid,
  weight       numeric(10, 4) not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, org_id),
  check (num_nonnulls(detection_id, room_id, link_id) >= 1),
  foreign key (boq_line_id, org_id)  references public.boq_lines (id, org_id) on delete cascade,
  foreign key (detection_id, org_id) references public.detections (id, org_id) on delete cascade,
  foreign key (room_id, org_id)      references public.rooms (id, org_id) on delete cascade,
  foreign key (link_id, org_id)      references public.links (id, org_id) on delete cascade
);
create index boq_line_evidence_line_idx on public.boq_line_evidence (boq_line_id);

-- ---------------------------------------------------------------------------
-- Business rules for boq_lines, enforced for end-user roles:
--   * new lines start as 'draft'
--   * only reviewer/admin may move a line to or from 'approved'
--   * approved_by / approved_at are stamped by the DB, never client-supplied
--   * content of an approved or locked line cannot change (un-approve first)
--   * a reviewer (without editor/admin) may only change status / note
-- ---------------------------------------------------------------------------
create or replace function app.boq_lines_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_can_edit   boolean;
  v_can_review boolean;
  v_content_changed boolean;
begin
  if not app.is_end_user() then
    -- privileged/system path: keep the approval stamp consistent
    if new.status = 'approved' then
      new.approved_at := coalesce(new.approved_at, now());
    else
      new.approved_by := null;
      new.approved_at := null;
    end if;
    return new;
  end if;

  v_can_edit   := app.has_role(new.org_id, array['admin', 'editor']);
  v_can_review := app.has_role(new.org_id, array['admin', 'reviewer']);

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'new BOQ lines must be draft' using errcode = '42501';
    end if;
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  v_content_changed :=
       new.item_id           is distinct from old.item_id
    or new.chapter           is distinct from old.chapter
    or new.code              is distinct from old.code
    or new.description       is distinct from old.description
    or new.unit              is distinct from old.unit
    or new.quantity          is distinct from old.quantity
    or new.quantity_override is distinct from old.quantity_override
    or new.qty_expr          is distinct from old.qty_expr
    or new.floor             is distinct from old.floor
    or new.room_id           is distinct from old.room_id
    or new.lifecycle         is distinct from old.lifecycle
    or new.supply            is distinct from old.supply
    or new.confidence        is distinct from old.confidence
    or new.level             is distinct from old.level
    or new.reasons           is distinct from old.reasons
    or new.locked            is distinct from old.locked
    or new.project_id        is distinct from old.project_id;

  if v_content_changed then
    if not v_can_edit then
      raise exception 'only editor/admin may change BOQ line content' using errcode = '42501';
    end if;
    if old.status = 'approved' or (old.locked and new.locked) then
      raise exception 'BOQ line % is approved/locked; un-approve before editing', old.id
        using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status then
    if (new.status = 'approved' or old.status = 'approved') and not v_can_review then
      raise exception 'only reviewer/admin may approve or un-approve BOQ lines' using errcode = '42501';
    end if;
    if not (v_can_edit or v_can_review) then
      raise exception 'not allowed to change BOQ line status' using errcode = '42501';
    end if;
  end if;

  if new.status = 'approved' then
    if old.status <> 'approved' then
      new.approved_by := auth.uid();
      new.approved_at := now();
    else
      new.approved_by := old.approved_by;
      new.approved_at := old.approved_at;
    end if;
  else
    new.approved_by := null;
    new.approved_at := null;
  end if;

  return new;
end $$;

create trigger boq_lines_guard
  before insert or update on public.boq_lines
  for each row execute function app.boq_lines_guard();
