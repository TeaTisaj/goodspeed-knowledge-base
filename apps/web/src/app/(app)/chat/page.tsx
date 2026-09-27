'use client';

import {
  classifyGrounding,
  type Citation,
  type Conversation,
  type DocumentSummary,
  type Grounding,
  type StreamEvent,
} from '@kb/contracts';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, streamAsk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Button, ErrorBanner } from '@/components/ui';
import { CitationCard, CitationNumber, CitationPreview } from '@/components/citation-card';
import {
  AlertIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChatIcon,
  CheckIcon,
  CopyIcon,
  LogoMark,
  PlusIcon,
  StopIcon,
} from '@/components/icons';
import { Markdown } from '@/components/markdown';
import { EASE_OUT, SPRING } from '@/components/motion';

type Stage = 'condensing' | 'retrieving' | 'generating';

interface Turn {
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

/** Within this many pixels of the bottom counts as "following" the stream. */
const PIN_THRESHOLD = 120;

export default function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [openCitation, setOpenCitation] = useState<Citation | null>(null);
  const [preview, setPreview] = useState<{ citation: Citation; anchor: DOMRect } | null>(null);
  const [pinned, setPinned] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
    } catch {
      // A failure to list history must not block asking a new question.
      setConversations((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  /**
   * Follows the stream only while the reader is at the bottom. Scrolling up to
   * re-read something stops the page from yanking them back down on every
   * token; "Jump to latest" brings them back.
   */
  useEffect(() => {
    const onScroll = () => {
      const gap = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      setPinned(gap < PIN_THRESHOLD);
      // The preview is positioned against where the marker was, so it goes stale on scroll.
      setPreview(null);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (pinned) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [turns, pinned]);

  function jumpToLatest() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }

  async function openConversation(id: string) {
    abortRef.current?.abort();
    setError(null);
    setConversationId(id);
    setPinned(true);
    try {
      const msgs = await api.listMessages(id);
      setTurns(
        msgs.map((msg) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          citations: msg.citations,
          model: msg.model,
          latencyMs: msg.latencyMs,
        })),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : 'Could not load that conversation');
    }
  }

  function startNew() {
    abortRef.current?.abort();
    setConversationId(undefined);
    setTurns([]);
    setError(null);
    inputRef.current?.focus();
  }

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    const q = question.trim();
    if (!q || busy) return;

    setQuestion('');
    setError(null);
    setBusy(true);
    setPinned(true);

    const userTurn: Turn = { id: `u-${Date.now()}`, role: 'user', content: q, citations: [] };
    const assistantId = `a-${Date.now()}`;
    setTurns((prev) => [
      ...prev,
      userTurn,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        citations: [],
        streaming: true,
        stages: [],
      },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => prev.map((t) => (t.id === assistantId ? fn(t) : t)));

    try {
      await streamAsk(
        { question: q, conversationId },
        (event: StreamEvent) => {
          switch (event.type) {
            case 'start':
              setConversationId(event.conversationId);
              break;
            case 'status':
              patch((t) => ({ ...t, stages: [...(t.stages ?? []), event.stage] }));
              break;
            case 'sources':
              // Candidates arrive before the answer, so something is on screen
              // while the text streams.
              patch((t) => ({ ...t, citations: event.sources, sourcesOnly: true }));
              break;
            case 'citations':
              // Narrowed to what the model actually cited, once the answer is
              // done. This is also what was persisted, so a reload shows the
              // same set rather than silently fewer.
              patch((t) => ({ ...t, citations: event.citations, sourcesOnly: false }));
              break;
            case 'token':
              patch((t) => ({ ...t, content: t.content + event.delta }));
              break;
            case 'usage':
              patch((t) => ({ ...t, model: event.model }));
              break;
            case 'error':
              setError(event.message);
              patch((t) => ({ ...t, streaming: false }));
              break;
            case 'done':
              patch((t) => ({ ...t, streaming: false }));
              break;
          }
        },
        controller.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof ApiError ? e.problem.title : 'The answer stream failed');
      }
      patch((t) => ({ ...t, streaming: false }));
    } finally {
      setBusy(false);
      abortRef.current = null;
      void loadConversations();
    }
  }

  function stop() {
    abortRef.current?.abort();
    setBusy(false);
  }

  function showPreview(citation: Citation, el: HTMLElement) {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    // Instant when moving between markers; a short delay only for the first.
    const delay = preview ? 0 : 120;
    previewTimer.current = setTimeout(
      () => setPreview({ citation, anchor: el.getBoundingClientRect() }),
      delay,
    );
  }

  function hidePreview() {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setPreview(null), 80);
  }

  function prefill(text: string) {
    setQuestion(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(text.length, text.length);
    });
  }

  return (
    <div className="flex flex-1 flex-col gap-6 lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-2 lg:sticky lg:top-20 lg:h-[calc(100vh-7rem)] lg:w-60">
        <Button variant="secondary" onClick={startNew} className="justify-start">
          <PlusIcon />
          New conversation
        </Button>
        <p className="mt-3 hidden px-2 text-xs font-medium text-[var(--color-ink-muted)] lg:block">
          History
        </p>
        <div className="-mx-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto px-1 lg:max-h-none">
          {conversations === null
            ? [0, 1, 2].map((i) => <div key={i} className="shimmer h-7 rounded-lg" />)
            : conversations.map((c) => {
                const active = c.id === conversationId;
                return (
                  <button
                    key={c.id}
                    onClick={() => void openConversation(c.id)}
                    title={`${c.title} · ${timeAgo(c.updatedAt)}`}
                    className={`relative shrink-0 truncate rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                      active
                        ? 'font-medium text-[var(--color-ink)]'
                        : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    {active && (
                      <m.span
                        layoutId="conversation-pill"
                        transition={SPRING}
                        className="absolute inset-0 rounded-lg bg-[var(--color-surface-muted)]"
                      />
                    )}
                    <span className="relative">{c.title}</span>
                  </button>
                );
              })}
        </div>
      </aside>

      <section className="mx-auto flex w-full max-w-3xl min-w-0 flex-1 flex-col">
        {turns.length === 0 ? (
          <ChatEmptyState onPick={prefill} />
        ) : (
          <div className="flex flex-col gap-8 pb-4">
            {turns.map((turn) =>
              turn.role === 'user' ? (
                <m.div
                  key={turn.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: EASE_OUT }}
                  className="flex flex-col items-end gap-1"
                >
                  <span className="sr-only">You</span>
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[var(--color-surface-muted)] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                    {turn.content}
                  </div>
                </m.div>
              ) : (
                <AssistantTurn
                  key={turn.id}
                  turn={turn}
                  onOpenCitation={(c) => {
                    setPreview(null);
                    setOpenCitation(c);
                  }}
                  onHoverCitation={showPreview}
                  onLeaveCitation={hidePreview}
                />
              ),
            )}
          </div>
        )}

        {error && (
          <div className="mb-3">
            <ErrorBanner message={error} />
          </div>
        )}

        <div className="sticky bottom-0 mt-auto bg-gradient-to-t from-[var(--color-canvas)] from-70% to-transparent pt-6 pb-4">
          <AnimatePresence>
            {!pinned && turns.length > 0 && (
              <m.button
                initial={{ opacity: 0, y: 6, x: '-50%' }}
                animate={{ opacity: 1, y: 0, x: '-50%' }}
                exit={{ opacity: 0, y: 6, x: '-50%' }}
                onClick={jumpToLatest}
                className="absolute -top-6 left-1/2 flex items-center gap-1.5 rounded-full border bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium shadow-md"
              >
                <ArrowDownIcon width={14} height={14} />
                {busy ? 'Follow answer' : 'Jump to latest'}
              </m.button>
            )}
          </AnimatePresence>

          <Composer
            inputRef={inputRef}
            value={question}
            onChange={setQuestion}
            onSubmit={ask}
            onStop={stop}
            busy={busy}
          />
        </div>
      </section>

      <CitationCard citation={openCitation} onClose={() => setOpenCitation(null)} />
      <CitationPreview target={preview} />
    </div>
  );
}

function AssistantTurn({
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
              key={c.chunkId}
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

function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  onStop: () => void;
  busy: boolean;
}) {
  // Grows with the text up to a cap, then scrolls.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, inputRef]);

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-end gap-2 rounded-2xl border bg-[var(--color-surface)] p-2 shadow-lg shadow-black/[0.04] transition-[border-color,box-shadow] focus-within:border-[var(--color-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_15%,transparent)]"
    >
      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter is a newline; never while an IME is composing.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Ask a question about your documents..."
        aria-label="Question"
        className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-[var(--color-ink-muted)] focus-visible:outline-none"
      />
      {busy ? (
        <Button variant="secondary" onClick={onStop} className="h-9 rounded-xl">
          <StopIcon />
          Stop
        </Button>
      ) : (
        <Button type="submit" disabled={!value.trim()} className="h-9 rounded-xl">
          <ArrowUpIcon />
          Ask
        </Button>
      )}
    </form>
  );
}

/**
 * First screen of a conversation. Suggestions come from the user's own ready
 * documents and only fill the box -- sending a canned question could easily hit
 * the relevance floor and make the first impression a refusal.
 */
function ChatEmptyState({ onPick }: { onPick: (text: string) => void }) {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);

  useEffect(() => {
    api.listDocuments().then(
      (res) => setDocs(res.items.filter((d) => d.status === 'ready').slice(0, 4)),
      () => undefined,
    );
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
      <m.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        className="flex size-12 items-center justify-center rounded-2xl border bg-[var(--color-surface)] text-[var(--color-accent)] shadow-sm"
      >
        <ChatIcon width={22} height={22} />
      </m.div>
      <h2 className="mt-5 text-xl font-semibold tracking-tight">Ask about your documents</h2>
      <p className="mt-1.5 max-w-md text-sm text-balance text-[var(--color-ink-muted)]">
        Answers are grounded in what you have written or uploaded, with a citation back to the exact
        passage behind each claim.
      </p>

      {docs.length > 0 && (
        <div className="mt-8 grid w-full max-w-xl gap-2 sm:grid-cols-2">
          {docs.map((d, i) => (
            <m.button
              key={d.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: EASE_OUT, delay: 0.1 + i * 0.05 }}
              onClick={() => onPick(`What does "${d.title}" say about `)}
              className="group rounded-xl border bg-[var(--color-surface)] px-3.5 py-3 text-left transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-sm"
            >
              <span className="text-xs text-[var(--color-ink-muted)]">Ask about</span>
              <span className="mt-0.5 block truncate text-sm font-medium transition-colors group-hover:text-[var(--color-accent)]">
                {d.title}
              </span>
            </m.button>
          ))}
        </div>
      )}
    </div>
  );
}
