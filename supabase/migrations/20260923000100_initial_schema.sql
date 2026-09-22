-- ---------------------------------------------------------------------------
-- Core schema: documents, chunks, ingestion jobs, conversations, messages.
--
-- Ownership is a plain `owner_id` on every row. The assignment scopes
-- visibility to a user's own documents and conversations, so there is no
-- tenancy/workspace concept. See DECISIONS.md.
-- ---------------------------------------------------------------------------

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- --- enums -----------------------------------------------------------------
create type public.ingestion_status as enum ('queued', 'processing', 'ready', 'failed');
create type public.message_role     as enum ('user', 'assistant');

-- --- documents -------------------------------------------------------------
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  title         text not null check (length(trim(title)) between 1 and 500),
  content       text not null default '',
  tags          text[] not null default '{}',

  -- Source of the text. `upload` rows keep the original file in Storage.
  source_type   text not null default 'text' check (source_type in ('text', 'upload')),
  source_path   text,

  -- Hash of the cleaned content. Lets re-ingestion skip untouched documents
  -- entirely, before any chunking work happens.
  content_hash  text,

  status        public.ingestion_status not null default 'queued',
  chunk_count   integer not null default 0,
  error_message text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index documents_owner_id_idx    on public.documents (owner_id);
create index documents_owner_created_idx on public.documents (owner_id, created_at desc);
create index documents_tags_idx        on public.documents using gin (tags);

-- --- chunks ----------------------------------------------------------------
-- `owner_id` and `tags` are denormalised from documents on purpose.
--
-- The RLS policy on this table runs on every vector search. Resolving ownership
-- through a join back to documents makes that policy a subquery per statement;
-- an indexed column comparison is measurably cheaper, and retrieval is the
-- hottest path in the app. The ingestion worker is the sole writer, so the two
-- copies cannot drift from ordinary application traffic.
create table public.chunks (
  id             uuid primary key default gen_random_uuid(),
  document_id    uuid not null references public.documents (id) on delete cascade,
  owner_id       uuid not null references auth.users (id) on delete cascade,

  chunk_index    integer not null,
  content        text not null,
  token_count    integer not null default 0,
  content_hash   text not null,

  tags           text[] not null default '{}',

  embedding      extensions.vector(1536),
  -- Which model produced `embedding`. Retrieval refuses to mix models, and this
  -- is what a re-ingestion migration keys off.
  embedding_model text not null,

  -- Generated, so it can never drift from `content`.
  fts            tsvector generated always as (to_tsvector('english', content)) stored,

  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),

  unique (document_id, chunk_index)
);

create index chunks_owner_id_idx    on public.chunks (owner_id);
create index chunks_document_id_idx on public.chunks (document_id);
create index chunks_tags_idx        on public.chunks using gin (tags);
create index chunks_fts_idx         on public.chunks using gin (fts);
create index chunks_content_hash_idx on public.chunks (content_hash);

-- HNSW over cosine distance. Defaults (m=16, ef_construction=64) are the
-- documented starting point; ef_search is tuned at query time without a rebuild.
-- 1536 dims fits under pgvector's 2000-dim ceiling for the `vector` type.
create index chunks_embedding_idx on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- --- embedding cache -------------------------------------------------------
-- Keyed by (content hash, model): identical text is embedded once, ever. This
-- is what makes re-ingestion cheap when a document is edited, and it is shared
-- across documents and users because the key is the text itself.
create table public.embedding_cache (
  content_hash text not null,
  model        text not null,
  embedding    extensions.vector(1536) not null,
  created_at   timestamptz not null default now(),
  primary key (content_hash, model)
);

-- --- ingestion jobs --------------------------------------------------------
-- User-visible job state. pg-boss owns its own schema for queue mechanics;
-- this table is what the UI polls, so job status needs no queue introspection.
create table public.ingestion_jobs (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents (id) on delete cascade,
  owner_id      uuid not null references auth.users (id) on delete cascade,
  status        public.ingestion_status not null default 'queued',
  attempt       integer not null default 0,
  chunks_created integer not null default 0,
  chunks_reused  integer not null default 0,
  error_message text,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index ingestion_jobs_document_idx on public.ingestion_jobs (document_id, created_at desc);
create index ingestion_jobs_owner_idx    on public.ingestion_jobs (owner_id);

-- --- conversations & messages ----------------------------------------------
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  title      text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_owner_idx on public.conversations (owner_id, updated_at desc);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  owner_id        uuid not null references auth.users (id) on delete cascade,
  role            public.message_role not null,
  content         text not null,

  -- Provenance, so the usage view can attribute cost per provider/model.
  provider         text,
  model            text,
  prompt_tokens    integer,
  completion_tokens integer,
  latency_ms       integer,

  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_owner_idx        on public.messages (owner_id);

-- --- citations -------------------------------------------------------------
-- Which chunks grounded which answer. `on delete set null` keeps a citation
-- readable after its source document is deleted, rather than silently vanishing
-- from an old conversation.
create table public.message_citations (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.messages (id) on delete cascade,
  chunk_id    uuid references public.chunks (id) on delete set null,
  document_id uuid references public.documents (id) on delete set null,
  owner_id    uuid not null references auth.users (id) on delete cascade,

  rank        integer not null,
  score       double precision,
  -- Snapshot of the cited text, so the citation survives re-chunking.
  quote       text,

  created_at  timestamptz not null default now()
);

create index message_citations_message_idx on public.message_citations (message_id, rank);

-- --- updated_at triggers ---------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger documents_touch_updated_at
  before update on public.documents
  for each row execute function public.touch_updated_at();

create trigger conversations_touch_updated_at
  before update on public.conversations
  for each row execute function public.touch_updated_at();
