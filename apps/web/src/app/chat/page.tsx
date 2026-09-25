'use client';

import {
  classifyGrounding,
  type Citation,
  type Conversation,
  type Grounding,
  type StreamEvent,
} from '@kb/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, streamAsk } from '@/lib/api';
import { Button, EmptyState, ErrorBanner, Spinner } from '@/components/ui';
import { CitationCard } from '@/components/citation-card';
import { Markdown } from '@/components/markdown';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  /** True while showing retrieval candidates rather than what was cited. */
  sourcesOnly?: boolean;
  streaming?: boolean;
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

const STAGE_LABEL: Record<string, string> = {
  condensing: 'Understanding the follow-up...',
  retrieving: 'Searching your documents...',
  generating: 'Writing an answer...',
};

export default function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openCitation, setOpenCitation] = useState<Citation | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
    } catch {
      // A failure to list history must not block asking a new question.
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  async function openConversation(id: string) {
    setError(null);
    setConversationId(id);
    try {
      const msgs = await api.listMessages(id);
      setTurns(
        msgs.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: m.citations,
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
    setStage(null);
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;

    setQuestion('');
    setError(null);
    setBusy(true);

    const userTurn: Turn = { id: `u-${Date.now()}`, role: 'user', content: q, citations: [] };
    const assistantId = `a-${Date.now()}`;
    setTurns((prev) => [
      ...prev,
      userTurn,
      { id: assistantId, role: 'assistant', content: '', citations: [], streaming: true },
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
              setStage(event.stage);
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
      setStage(null);
      abortRef.current = null;
      void loadConversations();
    }
  }

  function stop() {
    abortRef.current?.abort();
    setBusy(false);
    setStage(null);
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-2 lg:w-56">
        <Button variant="secondary" onClick={startNew}>
          New conversation
        </Button>
        <div className="flex max-h-32 flex-col gap-1 overflow-y-auto lg:max-h-none">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => void openConversation(c.id)}
              className={`shrink-0 truncate rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-[var(--color-surface-muted)] ${
                c.id === conversationId ? 'bg-[var(--color-surface-muted)] font-medium' : ''
              }`}
            >
              {c.title}
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-h-[calc(100vh-10rem)] flex-1 flex-col gap-3">
        {turns.length === 0 ? (
          <EmptyState
            title="Ask about your documents"
            description="Answers are grounded in your own documents, with citations back to the exact chunk that supported each claim."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {turns.map((turn) => (
              <div key={turn.id} className="flex flex-col gap-2">
                <span className="text-xs font-medium text-[var(--color-ink-muted)]">
                  {turn.role === 'user' ? 'You' : 'Assistant'}
                </span>

                <div
                  className={`rounded-md px-3 py-2 text-sm leading-relaxed ${
                    turn.role === 'user'
                      ? 'whitespace-pre-wrap bg-[var(--color-surface-muted)]'
                      : groundingOf(turn) === 'refusal'
                        ? 'border border-dashed text-[var(--color-ink-muted)]'
                        : 'border'
                  }`}
                >
                  {/* The question is shown verbatim; only the answer is
                      markdown, because only the answer is generated. */}
                  {turn.role === 'user' ? (
                    turn.content
                  ) : turn.content ? (
                    <Markdown
                      text={turn.content}
                      renderCitation={(n, key) => {
                        const c = turn.citations.find((x) => x.number === n);
                        return c ? (
                          <button
                            key={key}
                            onClick={() => setOpenCitation(c)}
                            title={c.documentTitle}
                            className="mx-0.5 rounded border px-1 align-super text-[0.7em] font-medium text-[var(--color-accent)] transition hover:bg-[var(--color-surface-muted)]"
                          >
                            {n}
                          </button>
                        ) : null;
                      }}
                    />
                  ) : (
                    !turn.streaming && '(no answer)'
                  )}
                  {turn.streaming && (
                    <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-current align-text-bottom" />
                  )}
                </div>

                {/* A confident answer with nothing behind it is the failure a
                    RAG UI most needs to surface, because it looks exactly like
                    a good one. */}
                {groundingOf(turn) === 'ungrounded' && (
                  <p className="text-xs text-[var(--color-warning)]" role="note">
                    This answer cites none of your documents. Check it before relying on it.
                  </p>
                )}

                {turn.role === 'assistant' && turn.citations.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-[var(--color-ink-muted)]">
                      {turn.sourcesOnly ? 'Searching:' : 'Cited:'}
                    </span>
                    {turn.citations.map((c) => (
                      <button
                        key={`${turn.id}-${c.number}`}
                        onClick={() => setOpenCitation(c)}
                        className="rounded-full border px-2 py-0.5 text-xs transition hover:bg-[var(--color-surface-muted)]"
                        title={c.documentTitle}
                      >
                        [{c.number}] {c.documentTitle || 'Source'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}

        {stage && <Spinner label={STAGE_LABEL[stage] ?? 'Working...'} />}
        {error && <ErrorBanner message={error} />}

        <form
          onSubmit={ask}
          className="sticky bottom-0 mt-auto flex gap-2 bg-[var(--color-surface)] pt-2 pb-4"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question about your documents..."
            className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm"
          />
          {busy ? (
            <Button variant="secondary" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!question.trim()}>
              Ask
            </Button>
          )}
        </form>
      </section>

      {openCitation && (
        <CitationCard citation={openCitation} onClose={() => setOpenCitation(null)} />
      )}
    </div>
  );
}
