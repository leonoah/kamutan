-- Demo seed (local dev / tests only). No customer PII: one demo org, one demo
-- project and its floor metadata. No users — add yourself as admin with e.g.
--   insert into public.memberships (org_id, user_id, role)
--   values ('00000000-0000-4000-8000-000000000001', '<your auth.users.id>', 'admin');
-- Runs as the migration owner (bypasses RLS).

insert into public.orgs (id, name, slug)
values ('00000000-0000-4000-8000-000000000001', 'משרד הדגמה', 'demo-office')
on conflict (id) do nothing;

insert into public.projects (id, org_id, name, status, default_cladding_height_m)
values ('00000000-0000-4000-8000-000000000101',
        '00000000-0000-4000-8000-000000000001',
        'בית משפחת נח', 'active', 1.200)
on conflict (id) do nothing;

insert into public.project_floors (id, org_id, project_id, code, name, sort_order, elevation_m)
values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000101', '-1', 'קומת מרתף', 0, -3.000),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000101', '0',  'קומת קרקע', 1,  0.000),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000101', '1',  'קומה א''',  2,  3.200)
on conflict (id) do nothing;
