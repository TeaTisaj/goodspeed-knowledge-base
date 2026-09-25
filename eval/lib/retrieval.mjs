/**
 * In-memory stand-in for the Postgres retrieval path, shared by both evals.
 *
 * Mirrors `hybrid_search`: a dense arm (cosine over the configured embedder), a
 * keyword arm, and Reciprocal Rank Fusion over the two. Running in memory keeps
 * the eval offline and database-free; the cost is that the keyword arm is an
 * approximation of Postgres full-text search, which is stated wherever it
 * matters rather than hidden.
 */
import { chunkText, reciprocalRankFusion } from '@kb/rag';

export const tokenize = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length > 1);

/**
 * The subset of Postgres's English stopwords that matter for short questions.
 * `websearch_to_tsquery` drops these before AND-ing the remaining terms, so a
 * "keyword match" means every *content* word of the question is present.
 */
const STOPWORDS = new Set(
  (
    'a an and are as at be by can could did do does for from had has have how i if in into is it ' +
    'its me my no not of on or our so than that the their them then there these they this to ' +
    'was we were what when where which who why will with would you your about after before ' +
    'should many much any'
  ).split(' '),
);

/** Crude suffix stripping, standing in for the Snowball stemmer Postgres uses. */
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');

/**
 * Approximates `fts @@ websearch_to_tsquery('english', q)`: every non-stopword
 * term of the query, stemmed, appears in the chunk. Stricter than Postgres in
 * places (no dictionary stemming), so the eval's relevance floor is, if
 * anything, slightly harder to pass than production's.
 */
export function keywordMatches(query, chunkStems) {
  const terms = tokenize(query)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
  return terms.length > 0 && terms.every((t) => chunkStems.has(t));
}

export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** BM25-lite, standing in for the Postgres full-text arm's ranking. */
function keywordRank(query, chunks, df, avgLen) {
  const terms = tokenize(query);
  const N = chunks.length;
  return chunks
    .map((c) => {
      let score = 0;
      for (const term of terms) {
        const f = c.tf.get(term);
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.len / avgLen))));
      }
      return { id: c.id, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Chunks and embeds a corpus. `docs` are `{ id, title, content }`. */
export async function buildIndex(embedder, docs, opts = { maxTokens: 512, overlapTokens: 64 }) {
  const chunks = [];
  for (const doc of docs) {
    for (const c of chunkText(doc.content, opts)) {
      chunks.push({
        id: `${doc.id}:${c.index}`,
        docId: doc.id,
        title: doc.title,
        content: c.content,
      });
    }
  }

  // Batched, as the ingestion worker does; one request per chunk is the
  // classic ingestion performance bug and would also trip free-tier limits.
  const vectors = [];
  for (let i = 0; i < chunks.length; i += 64) {
    const { embeddings } = await embedder.embed({
      texts: chunks.slice(i, i + 64).map((c) => c.content),
    });
    vectors.push(...embeddings);
  }

  const df = new Map();
  let totalLen = 0;
  chunks.forEach((c, i) => {
    c.vector = vectors[i];
    const tokens = tokenize(c.content);
    c.len = tokens.length;
    totalLen += tokens.length;
    c.tf = new Map();
    for (const t of tokens) c.tf.set(t, (c.tf.get(t) ?? 0) + 1);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    c.stems = new Set(tokens.map(stem));
  });

  return {
    chunks,
    df,
    avgLen: totalLen / (chunks.length || 1),
    byId: new Map(chunks.map((c) => [c.id, c])),
  };
}

/**
 * Ranked retrieval for one query, in the given mode. Every result carries the
 * absolute `similarity` and `keywordMatch` the relevance floor reads, exactly
 * as `hybrid_search` now returns them.
 */
export async function search(embedder, index, query, mode = 'hybrid', limit = 20) {
  const { chunks, df, avgLen, byId } = index;
  const { embeddings } = await embedder.embed({ texts: [query] });
  const qv = embeddings[0];

  const similarity = new Map(chunks.map((c) => [c.id, cosine(qv, c.vector)]));
  const semantic = chunks
    .map((c) => ({ id: c.id, score: similarity.get(c.id) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const keyword = keywordRank(query, chunks, df, avgLen).slice(0, limit);

  const ranked =
    mode === 'semantic'
      ? semantic
      : mode === 'keyword'
        ? keyword
        : reciprocalRankFusion([semantic, keyword]);

  return ranked.slice(0, limit).map((r) => {
    const c = byId.get(r.id);
    return {
      id: c.id,
      documentId: c.docId,
      documentTitle: c.title,
      content: c.content,
      score: r.score,
      similarity: similarity.get(c.id),
      keywordMatch: keywordMatches(query, c.stems),
    };
  });
}
