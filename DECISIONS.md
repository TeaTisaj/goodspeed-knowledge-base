# Decisions

Each entry: what we chose, what we rejected, and why. Short by design.
Environment facts are dated and were measured, not assumed.

---

## D0. Environment verification gate (M0)

The plan refused to assume three things that could not be known without running the stack.
Measured **2026-09-23** against Supabase CLI **2.117.0**.

| Question | Answer | Consequence |
|---|---|---|
| Postgres version | **17.6** | — |
| pgvector version | **0.8.2** | ≥0.8.0, so **iterative scan is available**; `set hnsw.iterative_scan = strict_order` verified settable. Matters because pgvector applies RLS *after* scanning the ANN index, so a filtered search can under-return rows without it. |
| `halfvec` type | present | Escape hatch if we ever exceed the 2,000-dim HNSW ceiling for `vector`. Not needed at 1536. |
| JWT algorithm | **ES256** (asymmetric, P-256) | JWKS at `/auth/v1/.well-known/jwks.json` serves the public key, and the `kid` in issued access tokens matches it. The auth guard verifies **locally via JWKS** — no shared secret, survives rotation. |
| Auth Admin API user creation | **works** | [supabase/cli#4820](https://github.com/supabase/cli/issues/4820) (`signing method HS256 is invalid` on local user creation) does **not** reproduce on 2.117.0. Seeding demo users via the Admin API is safe, so we avoid brittle raw `auth.users` inserts. |
| Email confirmation | disabled by default in `config.toml` | Signup works offline; the E2E test needs no mail server. |

Retained risk: these are facts about **CLI 2.117.0**. The CLI is pinned as a devDependency precisely
so a reviewer gets the same answers rather than whatever is current.

---

## D1. Chat Completions, not the Responses API

**Chosen:** target `/v1/chat/completions`.
**Rejected:** the Responses API, which OpenAI recommends for new projects.

The assignment's key requirement is that any OpenAI-spec-compatible provider swaps in via config.
Groq, Together, OpenRouter and Ollama implement Chat Completions; none implement Responses. Taking
the recommended path would have quietly broken the most heavily weighted requirement.

Cost, stated precisely: Chat Completions **still supports custom function calling** — it is not
deprecated. What is Responses-only is OpenAI's newest model's tool calling and OpenAI's hosted tools
(web search, code interpreter, MCP). Those are proprietary, so depending on them would break
portability regardless. v1 is a deterministic workflow that calls no tools, so today this costs
nothing.

---

## D2. One adapter plus presets, not five provider classes

**Chosen:** a single `OpenAICompatibleProvider` configured by a preset registry.
**Rejected:** one class per provider.

All five targets speak the same wire protocol, so five classes would be five copies of the same
code. The real variation is **capability and endpoint**, and that is what the interface models: a
declared `capabilities` descriptor validated at boot, so configuring Groq — which has no embeddings
endpoint — fails on startup with an actionable message instead of at request time.

---

## D3. RLS is the permission boundary, not application code

**Chosen:** request-scoped Supabase client built from the caller's JWT; Postgres enforces isolation
on every query including vector search.
**Rejected:** service-role key everywhere with `WHERE owner_id = ?` in application code.

Supabase's RAG-with-permissions guide confirms RLS applies to similarity search with no
`SECURITY DEFINER` wrapper. App-level filtering is one forgotten clause away from a cross-user leak,
and a `SECURITY DEFINER` match function with no user filter is the classic version of that bug.
Service-role credentials are held by the ingestion worker only.

---

*(Further entries — chunking, embedding model, retrieval, schema, queue, caching, workflow vs agent
— land as those milestones complete.)*
