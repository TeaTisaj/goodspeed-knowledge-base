-- ---------------------------------------------------------------------------
-- Requeue documents whose chunks were embedded by a different model.
--
-- A new embedding model of the same width passes the boot-time dimension
-- check, but search only compares vectors within one model, so every existing
-- chunk would silently drop out of retrieval. The worker calls this on startup
-- and the documents are re-ingested like any other queued document.
--
-- content_hash is cleared because ingestion skips a document whose hash still
-- matches. The old chunks stay until ingestion replaces them; search already
-- ignores them.
-- ---------------------------------------------------------------------------

create or replace function public.requeue_stale_embeddings(p_model text)
returns integer
language sql
-- Only the worker calls this, on the service role, which bypasses RLS anyway.
security invoker
set search_path = public
as $$
  with requeued as (
    update public.documents d
       set status        = 'queued',
           content_hash  = null,
           error_message = null
     where exists (
       select 1
         from public.chunks c
        where c.document_id = d.id
          and c.embedding_model <> p_model
     )
    returning 1
  )
  select count(*)::integer from requeued;
$$;

revoke all on function public.requeue_stale_embeddings(text) from public, anon, authenticated;
grant execute on function public.requeue_stale_embeddings(text) to service_role;
