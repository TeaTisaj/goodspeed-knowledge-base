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
}

export interface BuiltPrompt {
  system: string;
  /** Chunks that actually fit in the context, in citation order. */
  used: RetrievedChunk[];
}

const SYSTEM_PREAMBLE = `You answer questions using only the numbered sources below.

Rules:
- Use only information present in the sources. Do not rely on outside knowledge.
- Cite every claim with the source number in square brackets, like [1] or [2].
- If several sources support a claim, cite each one: [1][3].
- If the sources do not contain the answer, say so plainly. Do not guess.
- Be concise and concrete. Prefer the specific numbers and names in the sources.`;

export function buildPrompt(chunks: RetrievedChunk[], options: PromptOptions = {}): BuiltPrompt {
  const maxTokens = options.maxContextTokens ?? 8000;
  const count = options.countTokens ?? ((t: string) => Math.ceil(t.length / 4));

  const used: RetrievedChunk[] = [];
  const blocks: string[] = [];
  let budget = maxTokens - count(SYSTEM_PREAMBLE);

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
