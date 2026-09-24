-- ---------------------------------------------------------------------------
-- Report the real embedding dimension of the schema.
--
-- `AI_EMBEDDING_DIMENSIONS` was validated only against the provider preset, so
-- a configuration the provider was happy with could still be wrong for *this
-- database*: setting 768 for Ollama passed every check and then failed at the
-- first insert with `expected 1536 dimensions, not 768`, midway through
-- ingestion, far from the cause.
--
-- The column is the authority on this, not an environment variable, so the
-- application asks it at boot. pgvector stores the dimension directly in
-- `atttypmod` (unlike varchar, which offsets by 4), and an unconstrained
-- `vector` column reports -1, which is returned as null.
--
-- SECURITY DEFINER because `pg_attribute` is not reachable through PostgREST
-- as the caller. It takes no arguments, reads one fixed catalog row, and
-- returns an integer -- there is no input to inject and nothing to leak.
-- ---------------------------------------------------------------------------

create or replace function public.embedding_dimensions()
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select nullif(a.atttypmod, -1)
  from pg_attribute a
  join pg_class c     on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'chunks'
    and a.attname = 'embedding'
    and a.attnum > 0
    and not a.attisdropped;
$$;

revoke all on function public.embedding_dimensions() from public;
grant execute on function public.embedding_dimensions() to authenticated, service_role;
