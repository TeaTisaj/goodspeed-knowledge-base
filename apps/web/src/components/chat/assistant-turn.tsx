'use client';

import { classifyGrounding, type Citation, type Grounding } from '@kb/contracts';
import { AnimatePresence, m } from 'motion/react';
import { useState } from 'react';
import { AlertIcon, CheckIcon, CopyIcon, LogoMark } from '@/components/icons';
import { CitationNumber } from '@/components/citation-card';
import { Markdown } from '@/components/markdown';
import { EASE_OUT, SPRING } from '@/components/motion';

export type Stage = 'condensing' | 'retrieving' | 'generating';

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  /** True while showing retrieval candidates rather than what was cited. */
  sourcesOnly?: boolean;
  streaming?: boolean;
  /** Pipeline stages seen so far, in order, while this turn streams. */
  stages?: Stage[];
  model?: string | null;
  latencyMs?: number | null;
}

/**
 * How much the reader should trust a finished answer, derived from the stored
 * content and citations alone -- so a reloaded conversation shows exactly what
 * the live one did. Null while streaming or before the final citations arrive.
 */
function groundingOf(turn: Turn): Grounding | null {
  if (turn.role !== 'assistant' || turn.streaming || turn.sourcesOnly || !turn.content) return null;
  return classifyGrounding(turn.content, turn.citations.length);
}

const STAGE_LABEL: Record<Stage, [active: string, done: string]> = {
  condensing: ['Understanding the follow-up', 'Understood the follow-up'],
  retrieving: ['Searching your documents', 'Searched your documents'],
  generating: ['Writing an answer', 'Wrote the answer'],
};

export function AssistantTurn({
  turn,
  onOpenCitation,
  onHoverCitation,
  onLeaveCitation,
}: {
  turn: Turn;
  onOpenCitation: (c: Citation) => void;
  onHoverCitation: (c: Citation, el: HTMLElement) => void;
  onLeaveCitation: () => void;
}) {
  const grounding = groundingOf(turn);
  const waiting = turn.streaming && !turn.content;

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: EASE_OUT }}
      className="flex flex-col gap-3"
    >
      {/* A span, not a div: tests find the turn as the nearest div around this label. */}
      <span className="flex items-center gap-2 text-xs font-medium text-[var(--color-ink-muted)]">
        <LogoMark width={18} height={18} />
        <span>Assistant</span>
      </span>

      {waiting && turn.stages && turn.stages.length > 0 && <StageSteps stages={turn.stages} />}

      {(turn.content || !turn.streaming) && (
        <div
          className={`text-[15px] leading-7 ${
            grounding === 'refusal'
              ? 'rounded-xl border border-dashed px-4 py-3 text-sm text-[var(--color-ink-muted)]'
              : ''
          }`}
        >
          {/* The question is shown verbatim; only the answer is markdown,
              because only the answer is generated. */}
          {turn.content ? (
            <Markdown
              text={turn.content}
              renderCitation={(n, key) => {
                const c = turn.citations.find((x) => x.number === n);
                return c ? (
                  <button
                    key={key}
                    onClick={() => onOpenCitation(c)}
                    onMouseEnter={(e) => onHoverCitation(c, e.currentTarget)}
                    onMouseLeave={onLeaveCitation}
                    onFocus={onLeaveCitation}
                    aria-label={`Source ${n}: ${c.documentTitle}`}
                    className="mx-0.5 align-[0.15em] transition-transform duration-150 hover:scale-110 active:scale-95"
                  >
                    <CitationNumber n={n} />
                  </button>
                ) : null;
              }}
            />
          ) : (
            '(no answer)'
          )}
          {turn.streaming && turn.content && (
            <span className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
          )}
        </div>
      )}

      {waiting && (!turn.stages || turn.stages.length === 0) && <ThinkingDots />}

      {/* A confident answer with nothing behind it is the failure a RAG UI most
          needs to surface, because it looks exactly like a good one. */}
      {grounding === 'ungrounded' && (
        <p
          className="flex items-center gap-1.5 rounded-lg bg-[var(--color-warning-surface)] px-3 py-2 text-xs text-[var(--color-warning)]"
          role="note"
        >
          <AlertIcon width={14} height={14} />
          This answer cites none of your documents. Check it before relying on it.
        </p>
      )}

      {turn.citations.length > 0 && <SourceChips turn={turn} onOpen={onOpenCitation} />}

      {!turn.streaming && turn.content && <TurnFooter turn={turn} />}
    </m.div>
  );
}

/**
 * The pipeline made visible: the reader sees that the system looked before it
 * answered. Gives way to the answer as soon as the first token arrives.
 */
function StageSteps({ stages }: { stages: Stage[] }) {
  return (
    <ol className="flex flex-col gap-1.5" aria-live="polite">
      <AnimatePresence initial={false}>
        {stages.map((stage, i) => {
          const current = i === stages.length - 1;
          return (
            <m.li
              key={stage}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              className={`flex items-center gap-2 text-sm ${
                current ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'
              }`}
            >
              <span className="flex size-4 items-center justify-center">
                {current ? (
                  <span className="size-3 animate-spin rounded-full border-[1.5px] border-[var(--color-accent)] border-t-transparent" />
                ) : (
                  <CheckIcon width={14} height={14} className="text-[var(--color-success)]" />
                )}
              </span>
              <span className={current ? 'animate-pulse' : ''}>
                {STAGE_LABEL[stage][current ? 0 : 1]}
                {current && '...'}
              </span>
            </m.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}

function ThinkingDots() {
  return (
    <span className="flex gap-1 py-2" aria-label="Working">
      {[0, 1, 2].map((i) => (
        <m.span
          key={i}
          className="size-1.5 rounded-full bg-[var(--color-ink-muted)]"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
    </span>
  );
}

/**
 * Candidates first, then only what was cited. The narrowing is animated on
 * purpose: chips that were searched but not used fade out, so the reader sees
 * the answer rests on fewer sources than were considered.
 */
function SourceChips({ turn, onOpen }: { turn: Turn; onOpen: (c: Citation) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-[var(--color-ink-muted)]">
        {turn.sourcesOnly ? `Searching ${turn.citations.length} passages` : 'Sources'}
      </span>
      <div className="flex flex-wrap gap-1.5">
        <AnimatePresence mode="popLayout" initial={false}>
          {turn.citations.map((c, i) => (
            <m.button
              key={c.chunkId ?? `n${c.number}`}
              layout
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: turn.sourcesOnly ? 0.6 : 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ ...SPRING, delay: turn.sourcesOnly ? i * 0.03 : 0 }}
              onClick={() => onOpen(c)}
              aria-label={`[${c.number}] ${c.documentTitle || 'Source'}`}
              className="flex max-w-64 items-center gap-1.5 rounded-lg border bg-[var(--color-surface)] py-1 pr-2.5 pl-1 text-xs transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
            >
              <CitationNumber n={c.number} />
              <span className="truncate">{c.documentTitle || 'Source'}</span>
            </m.button>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function TurnFooter({ turn }: { turn: Turn }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); nothing useful to say.
    }
  }

  const meta = [
    turn.model,
    turn.latencyMs != null ? `${(turn.latencyMs / 1000).toFixed(1)}s` : null,
  ].filter(Boolean);

  return (
    <div className="flex items-center gap-3 text-xs text-[var(--color-ink-muted)]">
      <button
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy answer'}
        className="-ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <m.span
            key={copied ? 'check' : 'copy'}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.15 }}
          >
            {copied ? (
              <CheckIcon width={14} height={14} className="text-[var(--color-success)]" />
            ) : (
              <CopyIcon width={14} height={14} />
            )}
          </m.span>
        </AnimatePresence>
        {copied ? 'Copied' : 'Copy'}
      </button>
      {meta.length > 0 && <span className="tabular-nums">{meta.join(' · ')}</span>}
    </div>
  );
}
