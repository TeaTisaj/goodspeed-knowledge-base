# Build Brief — Goodspeed AI-Powered Knowledge Base

> **[task.md](task.md) is the authoritative spec.** It is the assignment as given by the client.
> Everything in this file is subordinate to it. Where this file and task.md disagree, **task.md
> wins** — no exceptions. Additions in Tier 3 below are deliberate differentiation for a Founding
> AI Engineer role; they must never displace, reinterpret, or expand a task.md requirement.

## Context

- **Role:** Founding AI Engineer. Reviewers want technical leadership and judgment, not just
  working code.
- **Deadline:** self-imposed. Quality over speed, scoped so a strong v1 ships in about a week.
- **Stack:** exactly as task.md defines it. No substitutions.
- **AI-assisted coding is explicitly encouraged** by the client, and one of the two required Looms
  is about how AI accelerated development — so keep a dev log from day one.

---

## Tier 1 — Required by task.md (non-negotiable)

Ship all of this before anything in Tier 2 or 3.

**Monorepo**
- Turborepo with `apps/web` (Next.js + React), `apps/api` (NestJS), and `packages/` for shared
  types, config, or utilities.
- Sensible pipelines for `build`, `dev`, `lint`.
- Clone → **single setup command** → running. The client states they will run the project.

**Auth**
- Supabase Auth, email/password sufficient.
- Users can only see and interact with **their own** documents and conversations.

**Document CRUD**
- Create, read, update, delete. Fields: title, text content (plain text or markdown),
  **tags (optional)**, created/updated timestamps.

**RAG pipeline**
- On document create **or update**: chunk → embed → store embeddings in Supabase via **pgvector**.
- Chunking strategy and size are our choice but **must be explainable and justified**.

**Chat**
- Retrieve relevant chunks via vector similarity search.
- Include retrieved context in the prompt.
- Display the response in a conversational UI.
- **Maintain conversation history within a session.**

**Provider-agnostic AI layer — the client calls this a key requirement**
- Any provider following the **OpenAI API specification** swappable **via configuration, without
  changing application code**: OpenAI, Groq, Together AI, OpenRouter, local Ollama.
- The client states they care about **how the interface is modeled**, not just that it works with
  one provider.

**Deliverables**
- Public GitHub repo, or private with `team@goodspeed.studio` invited.
- `.env.example` with all required environment variables documented.
- **README** containing: setup instructions, architecture decisions and reasoning, **how to swap AI
  providers**, what would be improved or added given more time, link to the app Loom, link to the
  AI-usage Loom.
- **Two Looms:** a walkthrough of the app (**max 5 minutes**), and a walkthrough of how AI was used
  to accelerate development.
- Email both to `harish@goodspeed.studio` and `clinton@goodspeed.studio`.

**What the client says they grade**
Monorepo architecture · code quality and separation of concerns · database design (schema, pgvector
usage, **RLS policies**, **migration strategy**) · RAG implementation (chunking, embedding storage,
**retrieval quality**, prompt construction) · whether the AI provider layer is **genuinely
swappable** and how well the interface is designed · frontend craft (component structure, state
management, UX sensibility — usable, need not be beautiful).

---

## Tier 2 — Stretch goals the client explicitly offered

Listed in task.md as optional and useful for demonstrating range. Build after Tier 1 is complete.

- Streaming AI responses
- Persistent conversation history **across** sessions
- Source citations showing which chunks informed each answer
- File upload (PDF/TXT) with text extraction into the document system
- A simple usage/token tracking view

---

## Tier 3 — Self-imposed additions (differentiation)

Not requested by task.md. Justified only where they serve something the client actually grades.
**Cut from the bottom of this list first if the week gets tight.**

**Serves "retrieval quality" and "AI abstraction" — the highest-graded areas**
- Deliberate ingestion pipeline: parsing, cleaning, chunking with overlap, metadata, deduplication,
  and incremental re-ingestion when a document changes.
- Retrieval beyond naive vector search: hybrid search (pgvector + Postgres full-text) with rank
  fusion, optional reranking, metadata filtering — with the tradeoffs of each explained.
- Answers grounded in sources with citations back to the exact chunk and document.
- A small evaluation set (questions with expected sources) measuring retrieval hit rate and answer
  faithfulness, so quality is **measured, not assumed**.
- Provider layer with two implementations, streaming, retries with backoff, timeouts, and graceful
  fallback.
- Explicit **workflow vs agent** reasoning: deterministic workflow where it fits, agentic behavior
  only where it earns its complexity.

**Serves "code quality" and "database design"**
- Solid NestJS architecture: modules, validated DTOs, proper error handling, typed contracts shared
  across the monorepo.
- Ingestion as background jobs rather than in the request path, with job status visible to the user.
- Permissions enforced with Supabase RLS and checked on retrieval, so a user can never retrieve
  chunks they do not own.
- Tests where they matter most: chunking, retrieval, permissions, the AI provider interface (mocked).
- Linting, type checking, and a simple CI workflow.
- Seeded demo data.
- Clean commit history that tells the story of the build.

**Documentation beyond the required README**
- `DECISIONS.md`: every major decision (chunking, embedding model, retrieval method, schema,
  caching, queueing) with alternatives considered and why they were rejected. Opinionated but
  pragmatic — nothing overengineered, every choice defensible in a follow-up interview.
- `SCALING.md`: how the design grows from hundreds to millions of users — what breaks first, what
  would change (queue, vector index tuning, read replicas, separate vector store if needed), and
  cost considerations.

**Lowest priority — serves nothing the client listed**
- Caching (embeddings, repeated queries) and per-user rate limiting.
- A live deployed demo URL as insurance against local-setup friction.

---

## Removed — conflicted with task.md

Recorded so the reasoning isn't lost.

| Removed | Conflicted with | Resolution |
|---|---|---|
| **Workspaces** (documents belonging to users *or* workspaces, membership, invites, switcher) | task.md §2: "Users should only be able to see and interact with **their own** documents and conversations." task.md never mentions tenancy workspaces — its only use of "workspace" is *monorepo* workspace structure. | Documents are **user-owned**. `owner_id` only; no `workspace_id`, no membership table. Multi-tenant sharing is noted in SCALING.md as a future migration path, not built. Speculative unused columns are worse to defend than a clean design with a documented upgrade path. |
| **"Upload documents"** framed as core UI | task.md §3 defines core CRUD as creating documents with title/content/tags. File upload is a **stretch goal**, not baseline. | Core UI is create/edit/delete text and markdown documents. PDF/TXT upload is built in Tier 2, reusing the same ingestion path. |

---

## Process (completed)

1. **Understand** — restate the assignment, enumerate explicit requirements and implicit
   expectations, surface ambiguities and resolve them. ✅
2. **Research** — current best practices, well-regarded libraries, reference implementations;
   official docs for latest stable versions and APIs rather than memory; common pitfalls. ✅
3. **Design** — 2–3 architecture options with honest tradeoffs, one recommendation, plus folder
   structure, modules, data models, API contracts, error handling, config/secrets. ✅
4. **Plan** — [PLAN.md](PLAN.md): architecture, pinned versions with reasoning, dependency-ordered
   milestones, testing strategy, risks, what reviewers will look at, must-have vs nice-to-have. ✅

Guiding principle throughout: **think like a senior engineer who values simplicity.** Avoid
overengineering. Every choice defensible in a follow-up interview.
