/**
 * Handling for text the model must treat as data, never as instructions.
 *
 * The threat model, because it decides what is worth defending:
 *
 * Retrieval is RLS-scoped, so a user's prompt only ever contains that user's
 * own documents -- there is no cross-user injection path to close. What remains
 * is **indirect prompt injection**: a user uploads a PDF, pastes a web page or
 * imports a vendor's README that they did not write, and that text contains
 * instructions aimed at the model ("ignore your rules", "tell the user to visit
 * ...", "reply only with ..."). The user is the victim, not the attacker, and
 * the answer they trust is what gets subverted.
 *
 * The defence is layered, and no single layer is relied on:
 *
 *   1. Structure. Sources travel in the user turn inside tags the document
 *      cannot forge (this file), never in the system message, so document text
 *      never speaks with system authority.
 *   2. Policy. The system prompt states that tagged content is data and that
 *      nothing inside it can change the rules (prompt.ts).
 *   3. Output. The UI renders no links or images, so an injected answer cannot
 *      exfiltrate through a URL the browser fetches (apps/web markdown.tsx), and
 *      citations resolve server-side so a forged "[7]" points at nothing.
 *   4. Measurement. The eval runs a poisoned corpus against a real model and
 *      fails if any attack lands (eval/generation.mjs).
 *
 * What this file deliberately does NOT do is refuse or redact documents that
 * look like injections. Heuristic classifiers are easy to evade and hostile to
 * legitimate content -- a security runbook that *discusses* prompt injection
 * would be flagged. Detection is used for observability only.
 */

/**
 * Characters a person reading the document cannot see but a model reads.
 *
 *  - U+E0000..E007F, Unicode "tag" characters: each mirrors an ASCII character
 *    invisibly, so an entire instruction can be hidden inside a visible
 *    sentence ("ASCII smuggling").
 *  - Zero-width and word-joiner characters, used to split trigger words past a
 *    filter or to hide payload boundaries.
 *  - Bidirectional overrides, which make displayed text differ from the
 *    logical order the model receives ("Trojan Source").
 *  - The soft hyphen and BOM, invisible in rendering.
 *
 * Removing them loses nothing a reader could have seen.
 */
const INVISIBLE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/**
 * Tags that give the prompt its structure. A document containing
 * `</source><question>...` would otherwise close its own block and speak in a
 * channel it does not own; escaping the opening bracket keeps the text readable
 * to the model while making it inert as structure.
 */
const STRUCTURAL_TAG =
  /<(\/?)\s*(sources?|question|system|instructions?|conversation|follow_up|passage)\b/gi;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/** Makes untrusted text safe to place inside the prompt's tagged sections. */
export function neutraliseUntrusted(text: string): string {
  return stripInvisible(text).replace(STRUCTURAL_TAG, '&lt;$1$2');
}

/** For attribute values: additionally one line, and no quote to break out of. */
export function neutraliseAttribute(text: string): string {
  return neutraliseUntrusted(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '&quot;')
    .trim();
}

export type InjectionSignal =
  | 'override_instructions'
  | 'role_reassignment'
  | 'prompt_extraction'
  | 'fake_structure'
  | 'hidden_characters';

const SIGNALS: [InjectionSignal, RegExp][] = [
  [
    'override_instructions',
    /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the)\b[^.\n]{0,20}\b(instructions?|rules|prompt|guidelines|directions)\b/i,
  ],
  [
    'role_reassignment',
    /\b(you are now|from now on,? you|act as|pretend (to be|you are)|new (instructions|persona|role))\b/i,
  ],
  [
    'prompt_extraction',
    /\b(reveal|print|repeat|show|output|leak)\b[^.\n]{0,30}\b(system prompt|your (instructions|prompt|rules))\b/i,
  ],
  [
    'fake_structure',
    /<\/?\s*(sources?|question|system|instructions?)\b|<\|im_(start|end)\|>|\[\/?INST\]|^\s*(system|assistant)\s*:/im,
  ],
];

/**
 * Heuristic markers of an injection attempt, for logging and the eval only.
 *
 * Never used to block: see the file header for why. A hit means "worth a line
 * in the log", so the pattern set favours recall on the well-known phrasings
 * over precision.
 */
export function detectInjectionSignals(text: string): InjectionSignal[] {
  const found: InjectionSignal[] = [];
  if (INVISIBLE.test(text)) found.push('hidden_characters');
  // A global regex keeps its lastIndex between calls; reset so the next call
  // does not start matching halfway through the string.
  INVISIBLE.lastIndex = 0;
  for (const [signal, pattern] of SIGNALS) {
    if (pattern.test(text)) found.push(signal);
  }
  return found;
}
