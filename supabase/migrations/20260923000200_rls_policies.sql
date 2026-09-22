-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- RLS is the permission boundary, not application code. The API builds a
-- request-scoped Supabase client from the caller's JWT, so Postgres enforces
-- isolation on every query -- including vector similarity search, which needs
-- no SECURITY DEFINER wrapper to respect these policies.
--
-- Every policy compares against `(select auth.uid())` rather than `auth.uid()`.
-- The subquery form is evaluated once per statement as an initPlan instead of
-- once per row. Supabase's published benchmark for exactly this change:
-- 179ms -> 9ms on a simple owner comparison, and 178,000ms -> 12ms on a
-- role-function policy. Every policy column is indexed (see initial schema).
-- ---------------------------------------------------------------------------

alter table public.documents         enable row level security;
alter table public.chunks            enable row level security;
alter table public.ingestion_jobs    enable row level security;
alter table public.conversations     enable row level security;
alter table public.messages          enable row level security;
alter table public.message_citations enable row level security;
alter table public.embedding_cache   enable row level security;

-- --- documents -------------------------------------------------------------
create policy "documents: owner can read"
  on public.documents for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "documents: owner can insert"
  on public.documents for insert to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "documents: owner can update"
  on public.documents for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "documents: owner can delete"
  on public.documents for delete to authenticated
  using ((select auth.uid()) = owner_id);

-- --- chunks ----------------------------------------------------------------
-- Read-only to users. Chunks are derived data: only the ingestion worker
-- writes them, and it uses the service role, which bypasses RLS. Granting no
-- write policy here means a compromised user token cannot forge retrievable
-- context -- which would be a prompt-injection vector, not just a data-integrity
-- problem.
create policy "chunks: owner can read"
  on public.chunks for select to authenticated
  using ((select auth.uid()) = owner_id);

-- --- ingestion jobs --------------------------------------------------------
create policy "ingestion_jobs: owner can read"
  on public.ingestion_jobs for select to authenticated
  using ((select auth.uid()) = owner_id);

-- --- conversations ---------------------------------------------------------
create policy "conversations: owner can read"
  on public.conversations for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "conversations: owner can insert"
  on public.conversations for insert to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "conversations: owner can update"
  on public.conversations for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "conversations: owner can delete"
  on public.conversations for delete to authenticated
  using ((select auth.uid()) = owner_id);

-- --- messages --------------------------------------------------------------
create policy "messages: owner can read"
  on public.messages for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "messages: owner can insert"
  on public.messages for insert to authenticated
  with check ((select auth.uid()) = owner_id);

-- --- citations -------------------------------------------------------------
create policy "message_citations: owner can read"
  on public.message_citations for select to authenticated
  using ((select auth.uid()) = owner_id);

-- --- embedding cache -------------------------------------------------------
-- No policy for `authenticated`, and RLS is enabled: with RLS on and no
-- permissive policy, every user-scoped query returns zero rows. Only the
-- service-role worker touches this table.
--
-- This matters because the cache is keyed by content hash across all users.
-- Exposing it would let one user confirm whether another had ingested a
-- specific piece of text -- a genuine cross-tenant leak through a side channel,
-- even though no row content is shared.
