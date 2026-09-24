/**
 * Prompt construction and citation handling.
 *
 * Retrieved chunks are numbered, and the model is told to cite those numbers.
 * Numbering rather than passing ids keeps the prompt small and gives the model
 * a token it can reliably reproduce; the mapping back to real chunk and
 * document ids stays on the server, so a hallucinated citation number resolves
 * to nothing instead of to the wrong document.
 */

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
}

export interface PromptOptions {
  /** Hard ceiling on context tokens, to stay inside the model's window. */
  maxContextTokens?: number;
  countTokens?: (text: string) => number;
  /**
   * Tokens already committed to this request outside the sources -- typically
   * the conversation history and the question.
   *
   * Without it the budget is not a budget: sources were fitted to the ceiling
   * and then history was appended on top, so the request could exceed the
   * model's window by exactly the amount of history carried. Sources yield to
   * history because history cannot be dropped without changing the question.
   */
  reservedTokens?: number;
}

export interface BuiltPrompt {
  system: string;
  /** Chunks that actually fit in the context, in citation order. */
  used: RetrievedChunk[];
}

const SYSTEM_PREAMBLE = `You are a knowledge assistant. You answer questions about the user's own
documents, using only the numbered sources below. Those sources were retrieved for this question;
they are all you know.

How to answer:
- Lead with the answer. First sentence resolves the question, then the supporting detail.
- Write in your own words. Pull the specific numbers, names, dates and conditions out of the
  sources and explain them — do not paste a sentence back as the whole answer.
- Synthesise. When several sources bear on the question, combine them into one coherent answer
  rather than listing what each source says in turn.
- Match the length to the question. A factual question gets a sentence or two; a "how does this
  work" question gets a short structured explanation. Never pad to seem thorough.
- Format with markdown where it earns its place: short paragraphs, a bullet list for genuine
  lists, bold for the key term. No headings unless the answer is long enough to need them.
- Reply in the language the user wrote in.

Grounding rules:
- Use only what the sources say. Never add outside knowledge, and never infer what a document
  "probably" means beyond what is written.
- Cite with the source number in square brackets at the end of the sentence it supports: [1], or
  [1][3] when several sources support the same claim. Every factual claim carries a citation.
- If the sources answer only part of the question, answer that part fully and say plainly which
  part they do not cover.
- If the sources do not answer the question at all, say so in one sentence. Do not guess, and do
  not fall back on general knowledge. If the sources are clearly about a related topic, you may
  name what they do cover so the user can ask a better question.`;

export function buildPrompt(chunks: RetrievedChunk[], options: PromptOptions = {}): BuiltPrompt {
  const maxTokens = options.maxContextTokens ?? 8000;
  const count = options.countTokens ?? ((t: string) => Math.ceil(t.length / 4));

  const used: RetrievedChunk[] = [];
  const blocks: string[] = [];
  let budget = maxTokens - count(SYSTEM_PREAMBLE) - (options.reservedTokens ?? 0);

  chunks.forEach((chunk) => {
    const block = `[${used.length + 1}] ${chunk.documentTitle}\n${chunk.content}`;
    const cost = count(block);
    // Drop rather than truncate: a half-sentence source invites a citation
    // that points at text the model never actually saw.
    if (cost > budget) return;
    budget -= cost;
    used.push(chunk);
    blocks.push(block);
  });

  const system =
    blocks.length > 0
      ? `${SYSTEM_PREAMBLE}\n\nSources:\n\n${blocks.join('\n\n')}`
      : `${SYSTEM_PREAMBLE}\n\nSources:\n\n(none found)`;

  return { system, used };
}

/** Citation markers the model emitted, deduplicated, in order of appearance. */
export function extractCitationNumbers(answer: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export interface ResolvedCitation {
  number: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  quote: string;
}

/**
 * Maps emitted numbers back to real chunks.
 *
 * Out-of-range numbers are dropped, not clamped. A model that invents "[9]"
 * against 5 sources must produce no citation at all — clamping would attach a
 * confident-looking link to a document that did not support the claim, which is
 * a worse failure than a missing citation.
 */
export function resolveCitations(answer: string, used: RetrievedChunk[]): ResolvedCitation[] {
  return extractCitationNumbers(answer)
    .filter((n) => n >= 1 && n <= used.length)
    .map((n) => {
      const chunk = used[n - 1]!;
      return {
        number: n,
        chunkId: chunk.id,
        documentId: chunk.documentId,
        documentTitle: chunk.documentTitle,
        quote: chunk.content.slice(0, 300),
      };
    });
}

/**
 * Rewrites a follow-up question into a standalone one.
 *
 * Runs only on multi-turn requests. Without it, "what about the second one?"
 * embeds to nothing useful and retrieval returns noise — a failure the
 * deterministic path cannot fix. First-turn questions skip this entirely, so
 * the common case costs no extra call.
 */
export function buildCondensePrompt(
  history: { role: 'user' | 'assistant'; content: string }[],
  question: string,
): string {
  const transcript = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  return `Rewrite the follow-up question as a standalone question that makes sense without the conversation.
Keep it short. Preserve every specific name, number and term. Output only the question.

Conversation:
${transcript}

Follow-up: ${question}

Standalone question:`;
}
