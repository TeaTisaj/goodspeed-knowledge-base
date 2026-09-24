import { describe, expect, it } from 'vitest';
import {
  ExtractionError,
  cleanExtractedText,
  deriveTitle,
  extractText,
  MAX_UPLOAD_BYTES,
} from './extract.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('cleanExtractedText', () => {
  it('rejoins words hyphenated across a line break', () => {
    // "deploy-\nment" is two useless tokens to a keyword index.
    expect(cleanExtractedText('the deploy-\nment process')).toContain('deployment');
  });

  it('unwraps hard-wrapped lines into sentences', () => {
    // The sentence splitter cannot find boundaries in hard-wrapped text.
    const out = cleanExtractedText('a rollback takes about\neight minutes to finish');
    expect(out).toBe('a rollback takes about eight minutes to finish');
  });

  it('preserves paragraph breaks', () => {
    expect(cleanExtractedText('First para.\n\nSecond para.')).toBe('First para.\n\nSecond para.');
  });

  it('does not unwrap before a capital letter, which may start a sentence', () => {
    const out = cleanExtractedText('End of thought.\nNew sentence here.');
    expect(out).toContain('\n');
  });

  it('strips headers repeated across pages', () => {
    // Boilerplate on every chunk drags them all toward the same embedding.
    const page = (n: number) => `ACME CONFIDENTIAL\nContent of page ${n} with real information.\nPage ${n}`;
    const doc = Array.from({ length: 10 }, (_, i) => page(i)).join('\n');
    const out = cleanExtractedText(doc);

    expect(out).not.toContain('ACME CONFIDENTIAL');
    expect(out).toContain('real information');
  });

  it('keeps a repeated long line, which is content rather than furniture', () => {
    const para =
      'This sentence is far too long to be a running header and should survive cleaning intact because it carries meaning.';
    const doc = Array.from({ length: 8 }, () => para).join('\n');
    expect(cleanExtractedText(doc)).toContain(para);
  });

  it('collapses the extra spaces column extraction leaves behind', () => {
    expect(cleanExtractedText('word    another')).toBe('word another');
  });
});

describe('extractText', () => {
  it('reads plain text', async () => {
    const r = await extractText(enc('# Runbook\n\nSome content here.'), { mimeType: 'text/plain' });
    expect(r.text).toContain('Some content here');
  });

  it('reads markdown', async () => {
    const r = await extractText(enc('# Title\n\nBody'), { mimeType: 'text/markdown' });
    expect(r.title).toBe('Title');
  });

  it('tolerates a charset parameter on the mime type', async () => {
    const r = await extractText(enc('hello world text'), {
      mimeType: 'text/plain; charset=utf-8',
    });
    expect(r.text).toContain('hello world');
  });

  it('extracts from a PDF through the injected extractor', async () => {
    const r = await extractText(enc('%PDF-1.4 fake'), {
      mimeType: 'application/pdf',
      pdfExtractor: async () => ({ text: '# Report\n\nRevenue was 4.2 million.', pageCount: 3 }),
    });
    expect(r.text).toContain('4.2 million');
    expect(r.pageCount).toBe(3);
  });

  it('reports a scanned PDF clearly instead of creating an empty document', async () => {
    // A PDF of images extracts to nothing. Silently creating an empty document
    // would leave a user wondering why answers never mention it.
    await expect(
      extractText(enc('%PDF'), {
        mimeType: 'application/pdf',
        pdfExtractor: async () => ({ text: '   \n  ', pageCount: 5 }),
      }),
    ).rejects.toThrow(/OCR/);
  });

  it('reports an unreadable PDF as corrupt rather than throwing a stack trace', async () => {
    await expect(
      extractText(enc('%PDF'), {
        mimeType: 'application/pdf',
        pdfExtractor: async () => {
          throw new Error('encrypted');
        },
      }),
    ).rejects.toThrow(/encrypted or corrupt/);
  });

  it('rejects an unsupported type by name', async () => {
    await expect(
      extractText(enc('MZ'), { mimeType: 'application/x-msdownload' }),
    ).rejects.toThrow(/Unsupported file type/);
  });

  it('rejects an empty file', async () => {
    await expect(extractText(new Uint8Array(0), { mimeType: 'text/plain' })).rejects.toThrow(
      ExtractionError,
    );
  });

  it('rejects a file over the size limit', async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    await expect(extractText(big, { mimeType: 'text/plain' })).rejects.toThrow(/larger than/);
  });
});

describe('deriveTitle', () => {
  it('prefers a markdown heading', () => {
    expect(deriveTitle('# Deployment runbook\n\nBody', 'x.pdf')).toBe('Deployment runbook');
  });

  it('falls back to the first substantial line', () => {
    expect(deriveTitle('Quarterly report 2026\nmore text', 'x.pdf')).toBe('Quarterly report 2026');
  });

  it('falls back to the filename without its extension', () => {
    expect(deriveTitle('', 'annual-report.pdf')).toBe('annual-report');
  });

  it('ignores an absurdly long heading', () => {
    const long = `# ${'x'.repeat(300)}\n\nShort line here`;
    expect(deriveTitle(long)).not.toHaveLength(302);
  });
});
