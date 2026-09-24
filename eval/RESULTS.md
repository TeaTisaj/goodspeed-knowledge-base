# Retrieval evaluation results

Produced by `pnpm eval`. Re-runnable, deterministic, and offline — it uses the fake embedding
provider so CI needs no API key.

**Corpus:** 8 documents, ~1,240 tokens each, 35 questions.
**Scoring:** chunk-level. A hit requires a _returned chunk_ to contain the answer span. Retrieving
the right document but the wrong chunk still produces a prompt that cannot answer the question, so
document-level scoring would flatter the system.

Last run: 2026-09-24, `fake/fake-embed-v1`.

> **These numbers moved on 2026-09-24**, and the reason is worth more than the numbers. `maxTokens`
> used to bound a chunk's _body_, with the overlap prefix added on top — so a "512-token chunk" was
> really up to 576, and the configured number meant something other than what it said. Making it a
> true ceiling shrank bodies to 448 tokens and took the corpus from 25 chunks to 40. Every figure
> below is from after that change; the conclusion it overturned is recorded rather than quietly
> replaced, because the overturning is the point.

---

## Retrieval mode — 512-token chunks, 64 overlap, 40 chunks

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
- **The default embedder is lexical**, so the semantic-vs-keyword comparison does not currently test
  what it is named after.
- **The overlap sweep varies two things at once**, since overlap changes the resulting chunk count.
- **Generation is not evaluated.** Faithfulness scoring needs an LLM judge and a real provider; only
  retrieval is measured here.
- **The questions were written alongside the corpus**, so they are cleaner than real user questions —
  fewer typos, no ambiguity, no multi-hop.

These are the reasons the numbers are published with their caveats rather than as a scoreboard. The
harness exists to make the next decision measurable, not to claim the current one is optimal — and
on 2026-09-24 it did exactly that by contradicting its own previous conclusion.
