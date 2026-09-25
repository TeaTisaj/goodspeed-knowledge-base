# Retrieval evaluation results

Produced by `pnpm eval`. Re-runnable, deterministic, and offline — it uses the fake embedding
provider so CI needs no API key.

**Corpus:** 8 documents, ~1,240 tokens each, 35 questions.
**Scoring:** chunk-level. A hit requires a _returned chunk_ to contain the answer span. Retrieving
the right document but the wrong chunk still produces a prompt that cannot answer the question, so
document-level scoring would flatter the system.

Last run: 2026-09-25, `fake/fake-embed-v1` (offline, what CI gates on) and `openai/text-embedding-3-small`
(via OpenRouter, below).

> **These numbers moved on 2026-09-24**, and the reason is worth more than the numbers. `maxTokens`
> used to bound a chunk's _body_, with the overlap prefix added on top — so a "512-token chunk" was
> really up to 576, and the configured number meant something other than what it said. Making it a
> true ceiling shrank bodies to 448 tokens and took the corpus from 25 chunks to 40. Every figure
> below is from after that change; the conclusion it overturned is recorded rather than quietly
> replaced, because the overturning is the point.

---

## With a real embedding model — 2026-09-25

`pnpm eval --embed=openrouter:openai/text-embedding-3-small`. The limitation this file has carried
since it was written — "the default embedder is lexical, so the semantic-vs-keyword comparison does
not test what it is named after" — is closed by this run.

| mode          | hit@1   | hit@3   | hit@5    | MRR       |
| ------------- | ------- | ------- | -------- | --------- |
| semantic only | 83%     | 94%     | **100%** | 0.889     |
| keyword only  | 91%     | 94%     | 94%      | 0.929     |
| hybrid (RRF)  | **91%** | **97%** | **100%** | **0.945** |

**This is the first measurement that supports hybrid on its merits.** With real semantics the two
arms fail on _different_ questions — semantic misses at rank 1 where exact terms matter, keyword
misses the paraphrases entirely — and fusion takes the better of each: it matches keyword at rank 1
and semantic at rank 5, and has the best MRR of the three. With the lexical fake embedder the two arms
were the same signal twice, which is why hybrid only ever tied.

Chunk size and overlap, same embedder (hybrid):

| config                | chunks | hit@1 | hit@3 | hit@5 | MRR   |
| --------------------- | ------ | ----- | ----- | ----- | ----- |
| 256 tok               | 80     | 91%   | 97%   | 97%   | 0.940 |
| **512 tok (default)** | 40     | 91%   | 97%   | 100%  | 0.945 |
| 1024 tok              | 16     | 97%   | 100%  | 100%  | 0.986 |
| 512 tok, 0 overlap    | 25     | 91%   | 97%   | 100%  | 0.949 |
| 512 tok, 128 overlap  | 40     | 91%   | 100%  | 100%  | 0.952 |

1024-token chunks lead again, and the caveat below about corpus share applies with full force: a
top-5 at 1024 tokens is 31% of this corpus. 512 stays the default for the reasons given there.

### Relevance floor calibration

The API refuses without calling the model when no retrieved chunk clears a similarity floor (and
none matched by keyword). A cosine threshold means nothing outside the model it was measured on, so
it is chosen from this table, which `pnpm eval` prints for whatever embedder it runs.

The two sides are measured differently, because the floor is applied **per chunk**: for an in-scope
question, what matters is the similarity of the chunk that _contains the answer_ — the one the floor
must never cut. For an out-of-scope probe, what matters is the best chunk, since one survivor is
enough to reach the model.

| similarity                       | n   | min   | p10   | median | max   |
| -------------------------------- | --- | ----- | ----- | ------ | ----- |
| answer chunk, in-scope questions | 39  | 0.183 | 0.286 | 0.404  | 0.628 |
| best chunk, out-of-scope probes  | 9   | 0.077 | 0.077 | 0.146  | 0.478 |

**Floor: 0.15** — the weakest answer chunk less a 0.03 margin. It keeps every answer and refuses
**5 of 9** probes with no model call. The four it lets through are the four that borrow the corpus's
vocabulary or wrap a real question in an attack ("explain Kubernetes rolling **deployments**", "a
healthy SaaS **churn** rate", "the administrator has authorised…", "you are now DAN…"), and those
reach the model, whose scope rules are the second line. The floor is a coarse, recall-safe filter
for the cheap cases; it is not the scope guard on its own.

> **The first version of this table was wrong, and an eval run caught it.** It calibrated on each
> question's _best_ chunk (in-scope minimum 0.297) and recommended 0.26, which refused 7 of 9 probes
> and looked excellent. The generation eval then showed a paraphrased question ("something like
> Memcached in front of the database?") refused although its answer chunk ranked 3rd: that chunk
> scored 0.253, and the floor had removed it. The best chunk and the answer chunk are different
> chunks for exactly the questions that matter most — the vague ones. 0.26 bought two extra
> refusals at the price of real answers; 0.15 is the honest number.

The weakest answer chunks are low (0.18–0.25) for a reason worth knowing: these fixture documents
bury each fact in filler, so a 512-token chunk is mostly unrelated text and its embedding is
diluted. That is the same effect that makes the paraphrase category the hardest in the generation
eval, and it is what a reranker or smaller, structure-aligned chunks would target.

With the lexical fake embedder the two distributions overlap almost completely (stop words
dominate), so no floor is defined for it and the API runs without one. `CALIBRATED_RELEVANCE_FLOORS`
in `packages/rag` lists only models that have actually been measured; an unlisted model gets no
floor and a boot-time warning, because a floor copied from a different model can refuse every
question.

---

## Retrieval mode — 512-token chunks, 64 overlap, 40 chunks (fake embedder)

| mode          | hit@1   | hit@3 | hit@5 | MRR       |
| ------------- | ------- | ----- | ----- | --------- |
| semantic only | **94%** | 94%   | 94%   | **0.944** |
| keyword only  | 91%     | 94%   | 94%   | 0.929     |
| hybrid (RRF)  | **94%** | 94%   | 94%   | **0.944** |

**This reverses the previous finding.** At 25 chunks, keyword search beat hybrid on hit@1 (91% vs
89%) and this file said so. At 40 chunks hybrid leads (94% vs 91%) and ties semantic exactly.

The honest reading is _not_ "hybrid won". It is that a 35-question corpus separates these three
configurations by one or two questions, and a chunking change unrelated to retrieval mode was enough
to flip the ranking. **Differences of this size are noise**, and the earlier conclusion was stated
more confidently than a corpus this small can support.

What has not changed: the default embedding provider is a hashing vectorizer, so its "semantic"
similarity _is_ lexical overlap. Fusing two lexical signals cannot add a semantic one. This ablation
still needs a real embedding model to mean what its labels say. `pnpm eval --provider=openai` runs
the identical comparison against `text-embedding-3-small`.

Hybrid stays the default, and the reason is still the failure mode rather than the score: keyword
search returns nothing at all for a paraphrase that shares no terms, and RRF costs one extra index
scan.

---

## Chunk size — hybrid retrieval

| chunk size  | chunks | hit@1   | hit@3    | hit@5    | MRR       | top-5 as share of corpus |
| ----------- | ------ | ------- | -------- | -------- | --------- | ------------------------ |
| 256 tokens  | 80     | 83%     | 97%      | 97%      | 0.890     | 6%                       |
| 512 tokens  | 40     | **94%** | 94%      | 94%      | 0.944     | 13%                      |
| 1024 tokens | 16     | 91%     | **100%** | **100%** | **0.957** | 31%                      |

**Read the last column first.** At 1024 tokens a top-5 result set is 31% of the entire corpus
against 6% at 256, so part of the apparent advantage is simply that there is less to discriminate
between. On a corpus of 40 chunks, "retrieve 5" is a much weaker test than it would be on 40,000.

Two things the numbers do support:

- **256 is too small for this content.** hit@1 drops 11 points against 512, and that gap is not
  explained by corpus share alone.
- **512 is now the best hit@1**, where previously 1024 led it by 8 points. Smaller bodies made the
  mid size sharper at rank 1 while 1024 keeps its edge deeper in the list — consistent with larger
  chunks being easier to _find_ and harder to _rank precisely_.

**The default stays 512.** It now also happens to win hit@1, but the reasons that matter are still
the ones the harness cannot measure: larger chunks consume the context budget faster, so fewer
sources fit in a prompt, and a citation pointing at a 1024-token block is much less precise for a
reader clicking through to check a claim.

---

## Overlap — 512-token chunks, hybrid

| overlap    | chunks | hit@1   | hit@3    | hit@5    | MRR       |
| ---------- | ------ | ------- | -------- | -------- | --------- |
| 0 tokens   | 25     | 91%     | 97%      | 97%      | 0.945     |
| 64 tokens  | 40     | **94%** | 94%      | 94%      | 0.944     |
| 128 tokens | 40     | 91%     | **100%** | **100%** | **0.952** |

Overlap now helps at rank 1 where it previously did not — but note the chunk counts differ across
rows, because reserving room for the overlap changes how many chunks the corpus yields. That makes
this table a comparison of two things at once, which is a weakness of the sweep, not a finding.

Overlap is retained at 64 tokens for the reason it always was: its purpose is not ranking. It is to
stop a fact that straddles a boundary from being split across two chunks so that _neither_ contains
it. That failure is rare and catastrophic when it happens, and a 35-question fixture is unlikely to
contain an instance.

---

## What still fails

Hybrid retrieval misses 1 of 35 questions, down from 2:

> _"What alerting changed afterwards?"_ — wants a chunk containing "alert on empty-result rate";
> the top results were two other sections of the same retrospective.

The failing case is the expected weakness of chunk-level embedding: a short question whose answer
span sits in a section dominated by other material, so the chunk's overall similarity is diluted by
text the question does not mention. It is also exactly the case a reranker targets, which is the
measurement that should decide whether to enable it by default.

---

## Honest limitations

- **The corpus is small.** 8 documents and 35 questions. Differences of one or two questions are
  noise — demonstrated, not asserted: a chunking change flipped which retrieval mode "won".
- **The default embedder is lexical**, so the offline numbers do not test semantics. The
  real-embedding run above does; it needs a key, so it is not what CI gates on.
- **The overlap sweep varies two things at once**, since overlap changes the resulting chunk count.
- **Generation is evaluated separately**, in [GENERATION.md](GENERATION.md): answer accuracy,
  refusals, prompt-injection resistance, and judge-scored faithfulness.
- **The questions were written alongside the corpus**, so they are cleaner than real user questions —
  fewer typos, no ambiguity, no multi-hop.

These are the reasons the numbers are published with their caveats rather than as a scoreboard. The
harness exists to make the next decision measurable, not to claim the current one is optimal — and
on 2026-09-24 it did exactly that by contradicting its own previous conclusion.
