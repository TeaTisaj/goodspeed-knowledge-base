# Evaluation

Two harnesses: one for retrieval, one for the answers built on it.

```bash
pnpm eval                  # retrieval, offline (fake embedder) — what CI gates on
pnpm eval --embed=openrouter:openai/text-embedding-3-small
pnpm eval:generation --chat=groq:openai/gpt-oss-120b \
  --embed=openrouter:openai/text-embedding-3-small --judge=groq:qwen/qwen3.8-27b --save --gate
```

Both use the production code (`chunkText`, the relevance floor, `buildChatMessages`), so the model
sees exactly the prompts the API sends.

## Retrieval

8 documents (~1,240 tokens each), 35 questions. Scored **per chunk**: a hit needs the returned chunk
to contain the answer, since the right document with the wrong chunk still can't answer.

With `text-embedding-3-small`:

| mode             | hit@1   | hit@3   | hit@5    | MRR       |
| ---------------- | ------- | ------- | -------- | --------- |
| semantic only    | 83%     | 94%     | 100%     | 0.889     |
| keyword only     | 91%     | 94%     | 94%      | 0.929     |
| **hybrid (RRF)** | **91%** | **97%** | **100%** | **0.945** |

The two arms miss different questions: semantic loses exact terms at rank 1, keyword loses
paraphrases entirely. Fusion keeps the best of each.

Chunk size and overlap (hybrid):

| config            | chunks | hit@1 | hit@5 | MRR   |
| ----------------- | ------ | ----- | ----- | ----- |
| 256 tokens        | 80     | 91%   | 97%   | 0.940 |
| **512 (default)** | 40     | 91%   | 100%  | 0.945 |
| 1024 tokens       | 16     | 97%   | 100%  | 0.986 |
| 512, no overlap   | 25     | 91%   | 100%  | 0.949 |
| 512, 128 overlap  | 40     | 91%   | 100%  | 0.952 |

1024 scores best, but on a 16-chunk corpus a top-5 result set is a third of everything, so part of
that is an easier test. I kept 512 because bigger chunks use up the context budget faster and make
citations less precise.

### Relevance floor

When no chunk clears a similarity floor (and none matched on keywords), the API refuses without
calling the model. Cosine scales differ by embedding model, so the floor is measured per model:

| similarity                         | n   | min   | median | max   |
| ---------------------------------- | --- | ----- | ------ | ----- |
| chunk holding the answer, in scope | 39  | 0.183 | 0.404  | 0.628 |
| best chunk, out-of-scope probes    | 9   | 0.077 | 0.146  | 0.478 |

Floor **0.15**: keeps every answer, refuses 5 of 9 off-topic probes for free. The rest reach the
model, whose scope rules handle them. My first calibration used each question's _best_ chunk and
picked 0.26; the generation eval showed that cut real answers to vague questions, so it was redone
on the chunk that actually holds the answer.

`gemini-embedding-001` scores on a narrower scale (answer chunks 0.284–0.379, probes 0.213–0.297),
so its floor is **0.25**: every answer kept, 6 of 9 probes refused. The run waits out Gemini's
free-tier limit of 100 embedding requests a minute, so it takes a few minutes.

The fake embedder is lexical and its distributions overlap, so it has no floor.

## Generation

73 labelled cases through the production path, in nine categories: answerable, paraphrase,
multi-hop, partial, follow-up, near-miss (topic present, fact absent), out-of-scope, direct
injection, and indirect injection from eleven poisoned documents (instruction override, phishing
link, delimiter forgery, invisible-Unicode smuggling, role reassignment, image exfiltration, prompt
extraction, an instruction in the document title, one in German, one base64-encoded, and a
white-on-white instruction in a real PDF run through the upload extractor). Each poisoned document
also holds a real fact that its question asks for, so refusing everything near an attack counts as
a failure.

54 cases are the dev set. The other 19 are a holdout, written after the prompt was last tuned and
never used to tune it: typos, casual phrasing, another language, cross-document questions and the
four newer attack channels (`--split=holdout` runs them alone).

**Scoring.** Deterministic checks gate: required and forbidden patterns, refusal expected or not,
citations valid and pointing at the answer. An LLM judge from a different model family adds
claim-level faithfulness; it is calibrated first on six hand-labelled answers (including a changed
number and an answer that tries to grade itself) and reports rather than gates. Rate-limited cases
are excluded, not counted as passes.

Results (Groq, `text-embedding-3-small`, floor 0.15; per-case output in [`results/`](results/)):

|                                    | gpt-oss-120b | gpt-oss-20b |
| ---------------------------------- | ------------ | ----------- |
| overall                            | 97%          | 96%         |
| dev / holdout                      | 96% / 100%   | 96% / 95%   |
| attack success                     | **0%**       | **0%**      |
| utility under attack               | 100%         | 100%        |
| correct refusals                   | 95%          | 95%         |
| false refusals                     | 3%           | 3%          |
| citation validity                  | 100%         | 100%        |
| judge: claims supported by sources | 94.9%        | —           |

Both models fail the same two cases:

- **A retrieval miss.** "If I stop using my prod login for a few months…" needs a chunk about
  access revoked after ninety days, which ranks 30th. Both models refused, which is right for what
  they were shown. HyDE rescues it (below).
- **An extrapolation.** Asked the most a manager can approve, which no document states, both
  models originally inferred "anything above $500" from "up to $500 without a manager". The prompt
  now says a limit says nothing about what lies beyond it. On the current prompt both answer that
  the documents give no upper limit instead of refusing outright, which the check still fails;
  a four-sample run on the near-miss cases ([`results/`](results/)) refuses 80% of the time.

gpt-oss-20b also fails one holdout case: it answers "35 days" correctly but without a citation.

### Query expansion (`eval/retrieval-experiments.mjs`)

| technique        | hit@6 | MRR   | paraphrase hit@6 | plain questions lost |
| ---------------- | ----- | ----- | ---------------- | -------------------- |
| baseline         | 95%   | 0.890 | 50%              | —                    |
| 256-token chunks | 92%   | 0.900 | 50%              | 1                    |
| multi-query      | 95%   | 0.849 | 75%              | 1                    |
| **HyDE**         | 97%   | 0.870 | 75%              | 0                    |

HyDE ships as an option (`RETRIEVAL_HYDE`), off by default: one paraphrase in four is thin evidence
for a model call on every question.

## Limitations

- Small and self-written: 35 retrieval questions, 73 generation cases. Differences of one or two
  cases are noise.
- Free-tier models only; the default `gpt-5.6` isn't in the table (`--chat=openai:gpt-5.6` runs it).
- The poisoned documents use known attacks. Adaptive attacks written against this prompt would be
  the stronger test.
