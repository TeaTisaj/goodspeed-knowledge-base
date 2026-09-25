-- ---------------------------------------------------------------------------
-- hybrid_search: let both arms use their indexes.
--
-- The previous version filtered chunks once in a shared CTE and read it from
-- both arms. A CTE referenced twice is materialized, so the vector arm sorted
-- every visible chunk instead of walking the HNSW index, and the keyword arm
-- skipped the GIN index. Each arm now queries `chunks` directly.
--
-- Iterative scan is enabled because RLS and the filters are applied after the
-- index returns candidates; without it a filtered search can come back short
-- (HNSW stops at ef_search = 40 rows by default).
-- ---------------------------------------------------------------------------

-- Loads pgvector's library, so `hnsw.*` is a known setting rather than a
-- placeholder only a superuser may attach to a function.
select '[1]'::extensions.vector;

create or replace function public.hybrid_search(
  query_text       text,
  query_embedding  extensions.vector(1536),
  match_count      int  default 12,
  rrf_k            int  default 50,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  filter_tags      text[] default null,
  filter_document_ids uuid[] default null,
  required_embedding_model text default null
)
returns table (
  id            uuid,
  document_id   uuid,
  chunk_index   int,
  content       text,
  tags          text[],
  token_count   int,
  score         double precision,
  semantic_rank int,
  full_text_rank int,
  similarity    double precision
)
language sql
stable
security invoker
set search_path = public, extensions
set hnsw.iterative_scan = strict_order
as $$
with
  semantic as (
    select s.id, row_number() over (order by s.distance) as rank_ix
    from (
      select c.id, c.embedding <=> query_embedding as distance
      from public.chunks c
      where c.embedding is not null
        and (filter_tags is null or c.tags && filter_tags)
        and (filter_document_ids is null or c.document_id = any (filter_document_ids))
        and (required_embedding_model is null or c.embedding_model = required_embedding_model)
      order by c.embedding <=> query_embedding
      limit least(greatest(match_count, 1), 100) * 4
    ) s
  ),
  full_text as (
    select t.id, row_number() over (order by t.rank desc) as rank_ix
    from (
      select c.id, ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) as rank
      from public.chunks c
      where query_text is not null
        and length(trim(query_text)) > 0
        and c.fts @@ websearch_to_tsquery('english', query_text)
        and (filter_tags is null or c.tags && filter_tags)
        and (filter_document_ids is null or c.document_id = any (filter_document_ids))
        and (required_embedding_model is null or c.embedding_model = required_embedding_model)
      order by rank desc
      limit least(greatest(match_count, 1), 100) * 4
    ) t
  )
select
  c.id,
  c.document_id,
  c.chunk_index,
  c.content,
  c.tags,
  c.token_count,
  ( coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
  + coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight
  )::double precision as score,
  semantic.rank_ix::int,
  full_text.rank_ix::int,
  -- For every row, including keyword-only hits, so the relevance floor judges
  -- each chunk on the same scale.
  case when c.embedding is null then null
       else (1 - (c.embedding <=> query_embedding))::double precision end as similarity
from semantic
full outer join full_text on semantic.id = full_text.id
join public.chunks c on c.id = coalesce(semantic.id, full_text.id)
order by score desc
limit least(greatest(match_count, 1), 100);
$$;

comment on function public.hybrid_search is
  'Vector + full-text retrieval fused with Reciprocal Rank Fusion, plus cosine similarity for the relevance floor. SECURITY INVOKER: RLS on chunks applies to the caller.';

alter function public.semantic_search(extensions.vector, int, text[], uuid[], text)
  set hnsw.iterative_scan = strict_order;
