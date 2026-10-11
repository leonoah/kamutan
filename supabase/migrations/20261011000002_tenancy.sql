-- 0002: orgs, profiles, memberships and the RLS helper functions.

create table public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  -- green_threshold, block_export_on_red, llm_enabled, llm_provider,
  -- llm_monthly_budget_usd, training_opt_in, default_waste_pct
  settings   jsonb not null default jsonb_build_object(
               'llm_enabled', false,
               'training_opt_in', false,
               'block_export_on_red', true,
               'llm_monthly_budget_usd', 30
             ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger orgs_updated_at before update on public.orgs
  for each row execute function app.set_updated_at();

-- User profile (spec name: `users`); id = auth.users.id. Not tenant-scoped.
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  locale     text not null default 'he',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function app.set_updated_at();

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.member_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, org_id)
);
create index memberships_org_idx on public.memberships (org_id);
create trigger memberships_updated_at before update on public.memberships
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS helper functions. SECURITY DEFINER (owner bypasses RLS on memberships,
-- which avoids policy recursion), STABLE, fixed empty search_path.
-- ---------------------------------------------------------------------------
create or replace function app.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid()
  )
$$;

create or replace function app.has_role(p_org uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org
      and m.user_id = auth.uid()
      and m.role::text = any (p_roles)
  )
$$;

-- Orgs the current user belongs to (handy for API list queries).
create or replace function app.my_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id from public.memberships m where m.user_id = auth.uid()
$$;

-- Two users share at least one org (profile visibility).
create or replace function app.shares_org_with(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships a
    join public.memberships b on b.org_id = a.org_id
    where a.user_id = auth.uid() and b.user_id = p_user
  )
$$;

revoke all on function app.is_member(uuid), app.has_role(uuid, text[]),
                       app.my_org_ids(), app.shares_org_with(uuid) from public;
grant execute on function app.is_member(uuid), app.has_role(uuid, text[]),
                          app.my_org_ids(), app.shares_org_with(uuid) to authenticated;

-- Bootstrap: an authenticated user creates an org and becomes its admin.
create or replace function app.create_org(p_name text, p_slug text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  insert into public.orgs (name, slug) values (p_name, p_slug) returning id into v_org;
  insert into public.memberships (org_id, user_id, role) values (v_org, v_uid, 'admin');
  return v_org;
end $$;
revoke all on function app.create_org(text, text) from public;
grant execute on function app.create_org(text, text) to authenticated;

-- An org must always keep at least one admin.
create or replace function app.memberships_keep_admin() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_org uuid := old.org_id;
begin
  if old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin' or new.org_id <> old.org_id)
     and exists (select 1 from public.orgs o where o.id = v_org)  -- org itself not being deleted
     and not exists (
       select 1 from public.memberships m
       where m.org_id = v_org and m.role = 'admin' and m.id <> old.id
     )
  then
    raise exception 'org % must keep at least one admin', v_org using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger memberships_keep_admin
  before update or delete on public.memberships
  for each row execute function app.memberships_keep_admin();

-- org_id / user_id of a membership are immutable.
create or replace function app.memberships_immutable_keys() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.user_id <> old.user_id then
    raise exception 'membership org_id/user_id are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger memberships_immutable_keys
  before update on public.memberships
  for each row execute function app.memberships_immutable_keys();
