#!/usr/bin/env node
/**
 * Retrieval experiments: which lever fixes paraphrase recall, at what cost?
 *
 * The generation eval's one persistent miss is a retrieval failure: "if I stop
 * using my prod login for a few months" never retrieves "access unused for
 * ninety days is revoked" (rank 30). Before changing the pipeline, each
 * candidate fix is measured on every dev question with a known answer span --
 * a technique that rescues paraphrases but costs the plain questions is not a
 * fix.
 *
 *   baseline    hybrid, 512-token chunks (production)
 *   chunk-256   hybrid, 256-token chunks: less filler diluting each vector
 *   multi-query an LLM writes 3 rephrasings; each is searched, results fused
 *   hyde        an LLM writes the passage that would answer; that is embedded
 *
 *   node eval/retrieval-experiments.mjs \
 *     --embed=openrouter:openai/text-embedding-3-small --chat=groq:openai/gpt-oss-20b
 *
 * Reported: hit@6 (6 is what the model sees), MRR, and hit@6 on the
 * paraphrase subset alone, plus the extra model calls each technique costs.
 */
import { buildChatProvider, buildEmbeddingProvider } from '@kb/ai';
import { reciprocalRankFusion } from '@kb/rag';
import { CORPUS } from './fixtures/build-corpus.mjs';
import { CASES } from './fixtures/generation-cases.mjs';
import { QUESTIONS } from './fixtures/questions.mjs';
import { loadEvalEnv, resolveTarget, withPatience } from './lib/providers.mjs';
import { buildIndex, search } from './lib/retrieval.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
loadEvalEnv();

const TOP_K = 6;
const embedder = buildEmbeddingProvider({
  ...resolveTarget(arg('embed', 'fake'), 'embedding'),
  dimensions: 1536,
});
const chat = buildChatProvider(resolveTarget(arg('chat', 'fake'), 'chat'));

const items = [
  ...QUESTIONS.map((x) => ({ q: x.q, span: x.span, paraphrase: false })),
  ...CASES.filter((c) => c.span && c.category === 'paraphrase' && (c.split ?? 'dev') === 'dev').map(
    (c) => ({ q: c.q, span: c.span, paraphrase: true }),
  ),
];

async function ask(prompt) {
  const r = await withPatience(() =>
    chat.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0, maxTokens: 1024 }),
  );
  return r.text.trim();
}

const rephrase = async (q) =>
  (
    await ask(
      `Write three different rephrasings of this question, as someone searching a company's internal ` +
        `policy documents might. Use the formal vocabulary a policy document would use. One per line, ` +
        `no numbering, nothing else.\n\nQuestion: ${q}`,
    )
  )
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((l) => l.length > 3)
    .slice(0, 3);

const hypothetical = (q) =>
  ask(
    `Write two sentences from an internal company policy document that would answer this question. ` +
      `State it as policy, with plausible specifics. Output only the two sentences.\n\nQuestion: ${q}`,
  );

/** The rank (1-based) of the first chunk containing the span, or Infinity. */
const rankOf = (ranked, span) => {
  const i = ranked.findIndex((r) => r.content.includes(span));
  return i === -1 ? Infinity : i + 1;
};

async function run(label, index, queryFor, callsPerQuestion) {
  const ranks = [];
  for (const item of items) {
    const queries = await queryFor(item.q);
    const lists = [];
    for (const q of queries) lists.push(await search(embedder, index, q, 'hybrid', 30));
    const byId = new Map(lists.flat().map((r) => [r.id, r]));
    const fused =
      lists.length === 1 ? lists[0] : reciprocalRankFusion(lists).map((f) => byId.get(f.id));
    ranks.push({ ...item, rank: rankOf(fused, item.span) });
    process.stdout.write('.');
  }
  const hit = (xs) => xs.filter((r) => r.rank <= TOP_K).length / (xs.length || 1);
  const mrr =
    ranks.reduce((s, r) => s + (Number.isFinite(r.rank) ? 1 / r.rank : 0), 0) / ranks.length;
  const para = ranks.filter((r) => r.paraphrase);
  return { label, hit: hit(ranks), mrr, paraHit: hit(para), ranks, callsPerQuestion };
}

console.log(
  `\nRetrieval experiments  (${embedder.id}/${embedder.model}; rewrites by ${chat.id}/${chat.model})`,
);
console.log(
  `  ${items.length} dev questions with a known answer span, ${items.filter((i) => i.paraphrase).length} of them paraphrases\n`,
);

const base = await buildIndex(embedder, CORPUS, { maxTokens: 512, overlapTokens: 64 });
const small = await buildIndex(embedder, CORPUS, { maxTokens: 256, overlapTokens: 32 });

const runs = [];
runs.push(await run('baseline', base, async (q) => [q], 0));
runs.push(await run('chunk-256', small, async (q) => [q], 0));
runs.push(await run('multi-query', base, async (q) => [q, ...(await rephrase(q))], 1));
runs.push(await run('hyde', base, async (q) => [q, await hypothetical(q)], 1));
console.log('\n');

const pct = (n) => `${(n * 100).toFixed(0)}%`.padStart(5);
console.log(
  `  ${'technique'.padEnd(12)} ${'hit@6'.padStart(6)} ${'MRR'.padStart(6)}  ${'paraphrase hit@6'.padStart(16)}  extra calls/question`,
);
for (const r of runs) {
  console.log(
    `  ${r.label.padEnd(12)} ${pct(r.hit).padStart(6)} ${r.mrr.toFixed(3).padStart(6)}  ${pct(r.paraHit).padStart(16)}  ${r.callsPerQuestion}`,
  );
}

console.log('\n  Paraphrase answer-chunk rank by technique:');
for (const [i, item] of items.entries()) {
  if (!item.paraphrase) continue;
  const cells = runs.map(
    (r) => `${r.label}=${Number.isFinite(r.ranks[i].rank) ? r.ranks[i].rank : '-'}`,
  );
  console.log(`    "${item.q.slice(0, 58)}"  ${cells.join('  ')}`);
}

// Which plain questions does each technique lose relative to baseline?
for (const r of runs.slice(1)) {
  const lost = r.ranks.filter((x, i) => x.rank > TOP_K && runs[0].ranks[i].rank <= TOP_K);
  if (lost.length)
    console.log(`\n  ${r.label} loses: ${lost.map((x) => `"${x.q.slice(0, 50)}"`).join(', ')}`);
}
console.log('');
