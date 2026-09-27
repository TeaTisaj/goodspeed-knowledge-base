'use client';

import type { Citation, Conversation, StreamEvent } from '@kb/contracts';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, streamAsk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Button, ErrorBanner } from '@/components/ui';
import { CitationCard, CitationPreview } from '@/components/citation-card';
import { AssistantTurn, type Turn } from '@/components/chat/assistant-turn';
import { ChatEmptyState } from '@/components/chat/chat-empty-state';
import { Composer } from '@/components/chat/composer';
import { ArrowDownIcon, PlusIcon } from '@/components/icons';
import { EASE_OUT, SPRING } from '@/components/motion';

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sets state only after its await
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
