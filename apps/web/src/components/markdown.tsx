/**
 * A deliberately small markdown renderer for answer text.
 *
 * Answers were rendered as `whitespace-pre-wrap`, so a model that produced
 * `**bold**` or a `-` list showed the raw characters. Documents are markdown,
 * the prompt asks for concise structured answers, and the model obliges — so
 * the UI was displaying syntax rather than formatting.
 *
 * Why not a library: the rendered text is model output, which makes this an
 * injection surface, and the subset worth supporting here is tiny. Every node
 * below is built from React elements, never from `dangerouslySetInnerHTML`, so
 * there is no HTML parsing step for a crafted answer to slip through. The one
 * safe-by-construction rule: input is treated as text, and structure comes only
 * from patterns this file recognises.
 *
 * Supported: headings, unordered and ordered lists, fenced code blocks, inline
 * code, bold, italics, and citation markers. Everything else renders as its
 * literal text, which is the right failure for a renderer this size.
 */

import type { ReactNode } from 'react';

/** Renders citation `n`, or returns null to leave the marker as text. */
export type RenderCitation = (n: number, key: string) => ReactNode | null;

/** `**bold**`, `*italic*`, `` `code` ``, `[n]` — applied to already-escaped text. */
function renderInline(text: string, keyPrefix: string, cite?: RenderCitation): ReactNode[] {
  const nodes: ReactNode[] = [];
  // One pass, alternating between the delimiters so nesting cannot desync.
  // Citation brackets match the server's parser, including gpt-oss's 【n】.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|((?:\[|\u3010|\uFF3B)\s*(\d{1,2})\s*(?:\]|\u3011|\uFF3D))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    const citation = match[5] && cite ? cite(Number(match[5]), key) : null;

    if (match[4]) {
      nodes.push(citation ?? token);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-[var(--color-surface-muted)] px-1 py-0.5 text-[0.9em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function Markdown({
  text,
  renderCitation,
}: {
  text: string;
  renderCitation?: RenderCitation;
}) {
  const inline = (t: string, k: string) => renderInline(t, k, renderCitation);
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];

  let listItems: string[] = [];
  let listOrdered = false;
  let codeLines: string[] | null = null;
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems.map((item, i) => (
      <li key={i} className="ml-4 list-outside">
        {inline(item, `li-${key}-${i}`)}
      </li>
    ));
    blocks.push(
      listOrdered ? (
        <ol key={`b${key++}`} className="list-decimal space-y-0.5 pl-4">
          {items}
        </ol>
      ) : (
        <ul key={`b${key++}`} className="list-disc space-y-0.5 pl-4">
          {items}
        </ul>
      ),
    );
    listItems = [];
  };

  for (const line of lines) {
    // --- fenced code ------------------------------------------------------
    if (line.trimStart().startsWith('```')) {
      if (codeLines === null) {
        flushList();
        codeLines = [];
      } else {
        blocks.push(
          <pre
            key={`b${key++}`}
            className="overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-2 text-xs"
          >
            <code>{codeLines.join('\n')}</code>
          </pre>,
        );
        codeLines = null;
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    // --- lists ------------------------------------------------------------
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet ?? numbered) {
      const ordered = numbered !== null;
      if (listItems.length > 0 && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      listItems.push((numbered?.[1] ?? bullet?.[1]) as string);
      continue;
    }
    flushList();

    // --- headings ---------------------------------------------------------
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={`b${key++}`} className="font-semibold">
          {inline(heading[2] as string, `h${key}`)}
        </p>,
      );
      continue;
    }

    // --- paragraph / blank ------------------------------------------------
    if (line.trim() === '') {
      blocks.push(<div key={`b${key++}`} className="h-2" />);
      continue;
    }
    blocks.push(
      <p key={`b${key++}`} className="leading-relaxed">
        {inline(line, `p${key}`)}
      </p>,
    );
  }

  // An unterminated fence still has to render, or a streaming answer shows
  // nothing until its closing backticks arrive.
  if (codeLines !== null && codeLines.length > 0) {
    blocks.push(
      <pre
        key={`b${key++}`}
        className="overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-2 text-xs"
      >
        <code>{codeLines.join('\n')}</code>
      </pre>,
    );
  }
  flushList();

  return <div className="text-sm">{blocks}</div>;
}
