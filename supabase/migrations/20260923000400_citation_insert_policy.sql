-- ---------------------------------------------------------------------------
-- Citations were readable but not writable.
--
-- The chat path persists messages and their citations through the caller's
-- RLS-scoped client, so it needs INSERT permission on message_citations the
-- same way it already has it on messages. Without this policy the insert was
-- rejected by RLS and, because the result was never checked, failed silently:
-- every answer was stored with zero citations.
--
-- Scoped to the caller's own rows, so a user can only ever attach citations to
-- their own messages.
-- ---------------------------------------------------------------------------

create policy "message_citations: owner can insert"
  on public.message_citations for insert to authenticated
  with check ((select auth.uid()) = owner_id);
