/**
 * Text extraction from uploaded files.
 *
 * Kept in the RAG package, not the API, because extraction is part of the
 * ingestion pipeline rather than an HTTP concern -- and because it is pure
 * enough to unit test without a server.
 */

export interface ExtractedDocument {
  text: string;
  /** Page count for PDFs; undefined for formats without pages. */
  pageCount?: number;
  /** Title from file metadata, when the format carries one. */
  title?: string;
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'corrupt' | 'empty' | 'too_large',
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
] as const;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * PDF text extraction leaves artefacts that hurt both chunking and retrieval:
 * hyphens splitting words across line breaks, hard-wrapped lines that turn one
 * sentence into many, and repeated headers or footers on every page. Cleaning
 * them is not cosmetic -- a word split as "deploy-\nment" is two useless tokens
 * to a keyword index, and the sentence splitter cannot find boundaries in
 * hard-wrapped text.
 */
export function cleanExtractedText(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n');

  // Rejoin words hyphenated across a line break.
  text = text.replace(/(\w)-\n(\w)/g, '$1$2');

  // Unwrap hard-wrapped lines: a newline between two lowercase-ish characters
  // is a wrap, not a paragraph break. Blank lines are preserved.
  text = text.replace(/([a-z,;:])\n(?=[a-z(])/g, '$1 ');

  // Collapse runs of spaces introduced by column extraction.
  text = text.replace(/[ \t]{2,}/g, ' ');

  return stripRepeatedLines(text)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Removes headers and footers.
 *
 * A short line repeated on most pages is running furniture, not content.
 * Leaving it in means every chunk shares the same boilerplate, which drags all
 * of them toward the same embedding and makes retrieval less discriminating.
 */
function stripRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const counts = new Map<string, number>();

  for (const line of lines) {
    const key = line.trim();
    // Only short lines are plausible furniture; a repeated paragraph is content.
    if (key.length === 0 || key.length > 80) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const threshold = Math.max(3, Math.ceil(lines.length / 40));
  const furniture = new Set(
    [...counts.entries()].filter(([, n]) => n >= threshold).map(([k]) => k),
  );
  if (furniture.size === 0) return text;

  return lines.filter((l) => !furniture.has(l.trim())).join('\n');
}

export interface ExtractOptions {
  mimeType: string;
  filename?: string;
  /** Injected so tests need no PDF fixture and the package stays dependency-light. */
  pdfExtractor?: (buffer: Uint8Array) => Promise<{ text: string; pageCount: number }>;
}

export async function extractText(
  buffer: Uint8Array,
  options: ExtractOptions,
): Promise<ExtractedDocument> {
  if (buffer.byteLength === 0) {
    throw new ExtractionError('The file is empty.', 'empty');
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ExtractionError(
      `The file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`,
      'too_large',
    );
  }

  const mime = options.mimeType.split(';')[0]!.trim().toLowerCase();

  if (mime === 'application/pdf') {
    if (!options.pdfExtractor) {
      throw new ExtractionError('No PDF extractor was provided.', 'unsupported');
    }
    let result: { text: string; pageCount: number };
    try {
      result = await options.pdfExtractor(buffer);
    } catch (error) {
      // Encrypted and malformed PDFs are common enough that this needs to be a
      // clear user-facing message, not a stack trace.
      throw new ExtractionError(
        `Could not read this PDF. It may be encrypted or corrupt. (${(error as Error).message})`,
        'corrupt',
      );
    }

    const text = cleanExtractedText(result.text);
    if (text.length === 0) {
      throw new ExtractionError(
        'No text found in this PDF. Scanned documents need OCR, which is not supported.',
        'empty',
      );
    }
    return { text, pageCount: result.pageCount, title: deriveTitle(text, options.filename) };
  }

  if (mime.startsWith('text/')) {
    const text = cleanExtractedText(new TextDecoder('utf-8').decode(buffer));
    if (text.length === 0) throw new ExtractionError('The file contains no text.', 'empty');
    return { text, title: deriveTitle(text, options.filename) };
  }

  throw new ExtractionError(
    `Unsupported file type "${mime}". Supported: PDF, plain text, markdown.`,
    'unsupported',
  );
}

/** First markdown heading, else first substantial line, else the filename. */
export function deriveTitle(text: string, filename?: string): string {
  const heading = text.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  if (heading && heading.length <= 200) return heading;

  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 3 && l.length <= 200);
  if (firstLine) return firstLine;

  return filename?.replace(/\.[^.]+$/, '') ?? 'Untitled document';
}
