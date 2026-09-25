-- ---------------------------------------------------------------------------
-- Answer quality, recorded per message.
--
-- The generation eval measures grounding, refusals and injection attempts
-- offline, on a fixture corpus. Production needs the same signals on real
-- traffic, or a regression -- a prompt change that starts answering from
-- general knowledge, a model swap that stops citing -- is invisible until a
-- user notices. Three facts per assistant message are enough:
--
--   grounding              'grounded' (cites a provided source), 'refusal', or
--                          'ungrounded' (neither: the failure that looks like a
--                          good answer). Same classifier as the UI and eval.
--   refused_without_model  the relevance floor refused; no model was called.
--   flagged_sources        sources that matched the injection heuristics.
--
-- Null grounding means the message predates this migration; the rollup skips
-- those rather than guessing.
-- ---------------------------------------------------------------------------

alter table public.messages
  add column grounding text check (grounding in ('grounded', 'refusal', 'ungrounded')),
  add column refused_without_model boolean not null default false,
  add column flagged_sources int not null default 0 check (flagged_sources >= 0);

-- SECURITY INVOKER: the messages owner policy applies inside, so a user only
-- ever aggregates their own answers -- the same rule as usage_summary.
create or replace function public.answer_quality_summary(
  since timestamptz default now() - interval '30 days'
)
returns table (
  answers               bigint,
  grounded              bigint,
  refusals              bigint,
  refused_without_model bigint,
  ungrounded            bigint,
  flagged_answers       bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*),
    count(*) filter (where m.grounding = 'grounded'),
    count(*) filter (where m.grounding = 'refusal'),
    count(*) filter (where m.refused_without_model),
    count(*) filter (where m.grounding = 'ungrounded'),
    count(*) filter (where m.flagged_sources > 0)
  from public.messages m
  where m.role = 'assistant'
    and m.grounding is not null
    and m.created_at >= since;
$$;

comment on function public.answer_quality_summary is
  'Per-user answer grounding, refusal and injection-signal counts. SECURITY INVOKER: RLS on messages applies.';
