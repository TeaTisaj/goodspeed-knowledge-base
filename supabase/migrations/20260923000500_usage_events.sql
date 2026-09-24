-- ---------------------------------------------------------------------------
-- Usage tracking.
--
-- The AI layer already emits a usage event for every chat and embedding call
-- via the UsageTracking decorator; this is where they land so they can be
-- queried per user, provider and model.
--
-- Written by the service role only -- the figures are billing-adjacent, and a
-- user being able to insert their own rows would make the numbers meaningless.
-- Read access is scoped to the owner.
-- ---------------------------------------------------------------------------

create table if not exists public.usage_events (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  operation         text not null check (operation in ('chat', 'embed', 'rerank', 'condense')),
  provider          text not null,
  model             text not null,
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens      integer not null default 0,
  -- Nullable on purpose: an unknown model prices at null rather than zero, so
  -- "we do not know" is distinguishable from "it was free".
  estimated_cost_usd numeric(12, 6),
  latency_ms        integer,
  created_at        timestamptz not null default now()
);

create index usage_events_owner_created_idx on public.usage_events (owner_id, created_at desc);
create index usage_events_owner_model_idx   on public.usage_events (owner_id, provider, model);

alter table public.usage_events enable row level security;

create policy "usage_events: owner can read"
  on public.usage_events for select to authenticated
  using ((select auth.uid()) = owner_id);

-- No insert policy: only the service-role worker writes usage.

-- Rollup for the usage view. SECURITY INVOKER, so the owner policy above
-- applies inside it and a user can only ever aggregate their own rows.
create or replace function public.usage_summary(since timestamptz default now() - interval '30 days')
returns table (
  provider           text,
  model              text,
  operation          text,
  calls              bigint,
  prompt_tokens      bigint,
  completion_tokens  bigint,
  total_tokens       bigint,
  estimated_cost_usd numeric,
  avg_latency_ms     numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    e.provider,
    e.model,
    e.operation,
    count(*)                        as calls,
    sum(e.prompt_tokens)::bigint    as prompt_tokens,
    sum(e.completion_tokens)::bigint as completion_tokens,
    sum(e.total_tokens)::bigint     as total_tokens,
    sum(e.estimated_cost_usd)       as estimated_cost_usd,
    round(avg(e.latency_ms), 0)     as avg_latency_ms
  from public.usage_events e
  where e.created_at >= since
  group by e.provider, e.model, e.operation
  order by total_tokens desc;
$$;
