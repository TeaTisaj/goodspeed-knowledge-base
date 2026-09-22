-- ---------------------------------------------------------------------------
-- Hybrid retrieval: dense vector search fused with Postgres full-text search
-- using Reciprocal Rank Fusion.
--
-- Why RRF rather than blending scores: cosine distance and ts_rank are not on
-- comparable scales, so any weighted sum needs normalisation constants that
-- drift with the corpus. RRF only consumes *ranks*, so it is scale-free and has
-- no tuning surface beyond k.
--
-- SECURITY INVOKER (the default for `language sql`, stated explicitly here
-- because it is the load-bearing detail): the function runs as the caller, so
-- the RLS policies on `chunks` apply inside it. A SECURITY DEFINER version with
-- no user filter is the classic way a RAG app leaks chunks across users.
-- ---------------------------------------------------------------------------

create or replace function public.hybrid_search(
  query_text       text,
  query_embedding  extensions.vector(1536),
  match_count      int  default 12,
  rrf_k            int  default 50,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  filter_tags      text[] default null,
  filter_document_ids uuid[] default null,
  -- Guards against mixing embedding spaces. Retrieval with a vector from a
  -- different model is silently meaningless, so it is rejected structurally.
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
  full_text_rank int
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
with
  -- Over-fetch from each arm so fusion has something to work with. pgvector
  -- applies RLS *after* scanning the ANN index, so a filtered search can
  -- under-return; pgvector 0.8's iterative scan plus this headroom covers it.
  candidate_limit as (
    select least(greatest(match_count, 1), 100) * 4 as n
  ),
  filtered as (
    select c.*
    from public.chunks c
    where (filter_tags is null or c.tags && filter_tags)
      and (filter_document_ids is null or c.document_id = any (filter_document_ids))
      and (required_embedding_model is null or c.embedding_model = required_embedding_model)
  ),
  semantic as (
    select f.id,
           row_number() over (order by f.embedding <=> query_embedding) as rank_ix
    from filtered f
    where f.embedding is not null
    order by f.embedding <=> query_embedding
    limit (select n from candidate_limit)
  ),
  full_text as (
    select f.id,
           row_number() over (
             order by ts_rank_cd(f.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank_ix
    from filtered f
    where query_text is not null
      and length(trim(query_text)) > 0
      and f.fts @@ websearch_to_tsquery('english', query_text)
    limit (select n from candidate_limit)
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
  full_text.rank_ix::int
from semantic
full outer join full_text on semantic.id = full_text.id
join public.chunks c on c.id = coalesce(semantic.id, full_text.id)
order by score desc
limit least(greatest(match_count, 1), 100);
$$;

comment on function public.hybrid_search is
  'Vector + full-text retrieval fused with Reciprocal Rank Fusion. SECURITY INVOKER: RLS on chunks applies to the caller.';

-- Vector-only retrieval, kept so the eval harness can measure what hybrid
-- search actually buys instead of assuming it helps.
create or replace function public.semantic_search(
  query_embedding extensions.vector(1536),
  match_count     int default 12,
  filter_tags     text[] default null,
  filter_document_ids uuid[] default null,
  required_embedding_model text default null
)
returns table (
  id          uuid,
  document_id uuid,
  chunk_index int,
  content     text,
  tags        text[],
  token_count int,
  score       double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select c.id, c.document_id, c.chunk_index, c.content, c.tags, c.token_count,
         (1 - (c.embedding <=> query_embedding))::double precision as score
  from public.chunks c
  where c.embedding is not null
    and (filter_tags is null or c.tags && filter_tags)
    and (filter_document_ids is null or c.document_id = any (filter_document_ids))
    and (required_embedding_model is null or c.embedding_model = required_embedding_model)
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 100);
$$;
