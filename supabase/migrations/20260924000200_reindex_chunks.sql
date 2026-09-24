-- ---------------------------------------------------------------------------
-- Re-index a document's surviving chunks in one statement pair.
--
-- Re-ingestion previously issued up to 2N PostgREST round trips to renumber
-- kept chunks: one pass to shift every moved row into negative indexes (to
-- dodge the `(document_id, chunk_index)` unique constraint) and a second to
-- settle them. Editing the first section of a long document touched every
-- chunk after it, so a 60-chunk document cost 120 sequential HTTP calls.
--
-- Worse than slow, it was not atomic. Each call committed on its own, so a
-- crash mid-loop left rows parked at negative indexes, which no read path
-- expects. Moving both passes into one function makes them a single
-- transaction: either the renumbering lands or none of it does.
--
-- The negative-index dance survives because the constraint is immediate; the
-- two passes just run inside one transaction now rather than across many.
-- ---------------------------------------------------------------------------

create or replace function public.reindex_chunks(
  p_document_id uuid,
  p_updates     jsonb,
  p_tags        text[]
)
returns integer
language plpgsql
-- SECURITY INVOKER: the only caller is the ingestion worker on the service
-- role, which already bypasses RLS. A definer function here would hand the
-- same power to anyone who could reach it.
security invoker
set search_path = public
as $$
declare
  affected integer;
begin
  if p_updates is null or jsonb_array_length(p_updates) = 0 then
    return 0;
  end if;

  -- Pass 1: park every row in negative space, where nothing collides.
  update public.chunks c
     set chunk_index = -1 - u.to_index
    from jsonb_to_recordset(p_updates) as u(id uuid, to_index integer)
   where c.id = u.id
     and c.document_id = p_document_id;

  -- Pass 2: settle into final positions, refreshing the denormalised tags at
  -- the same time so a tag edit cannot be left half-applied.
  update public.chunks c
     set chunk_index = u.to_index,
         tags        = p_tags
    from jsonb_to_recordset(p_updates) as u(id uuid, to_index integer)
   where c.id = u.id
     and c.document_id = p_document_id;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.reindex_chunks(uuid, jsonb, text[]) from public;
grant execute on function public.reindex_chunks(uuid, jsonb, text[]) to service_role;
