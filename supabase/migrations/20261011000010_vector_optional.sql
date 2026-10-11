-- 0010: optional pgvector support. Only applied when the `vector` extension is
-- available on the server (Supabase: yes; PGlite test DB: skipped).

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    create extension if not exists vector with schema extensions;
    alter table public.symbol_templates add column if not exists embedding extensions.vector(768);
    alter table public.item_library     add column if not exists embedding extensions.vector(768);
  else
    raise notice 'pgvector not available; embedding columns not created';
  end if;
end $$;
