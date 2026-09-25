/**
 * Text the model must treat as data, never as instructions.
 *
 * Retrieval is RLS-scoped, so the threat is indirect prompt injection: a user
 * uploads a document they did not write, and it tries to steer the answer.
 * Defences are layered -- tagged structure (here), policy (prompt.ts), output
 * with no links or images (web), and a poisoned-corpus eval. Nothing here
 * blocks content: heuristics are easy to evade and would refuse a runbook that
 * merely discusses injection, so detection is for logging only.
 */

/**
 * Invisible to a reader, visible to a model: Unicode tag characters (ASCII
 * smuggling), zero-width joiners, bidi overrides, soft hyphen and BOM.
 */
const INVISIBLE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/** Prompt structure tags; escaped so a document cannot close its own block. */
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

/** Heuristic injection markers, for logs and the eval. Never used to block. */
export function detectInjectionSignals(text: string): InjectionSignal[] {
  const found: InjectionSignal[] = [];
  if (INVISIBLE.test(text)) found.push('hidden_characters');
  // Global regexes keep lastIndex between calls.
  INVISIBLE.lastIndex = 0;
  for (const [signal, pattern] of SIGNALS) {
    if (pattern.test(text)) found.push(signal);
  }
  return found;
}
