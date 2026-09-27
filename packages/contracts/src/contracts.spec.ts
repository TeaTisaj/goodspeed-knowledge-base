import { describe, expect, it } from 'vitest';
import {
  askSchema,
  classifyGrounding,
  isNoAnswer,
  NO_ANSWER,
  createDocumentSchema,
  listDocumentsQuerySchema,
  problemDetailsSchema,
  streamEventSchema,
  updateDocumentSchema,
} from './index.js';

/**
 * These schemas are the API contract, shared by the server for validation and
 * by the web app for its types. The limits encoded here are real defences, so
 * they get real tests.
 */
describe('createDocumentSchema', () => {
  it('accepts a minimal document and defaults the tags', () => {
    const r = createDocumentSchema.parse({ title: 'Notes', content: 'Hello' });
    expect(r).toEqual({ title: 'Notes', content: 'Hello', tags: [] });
  });

  it('rejects missing or blank content, which would index to nothing', () => {
    expect(createDocumentSchema.safeParse({ title: 'Notes' }).success).toBe(false);
    expect(createDocumentSchema.safeParse({ title: 'Notes', content: ' \n ' }).success).toBe(false);
  });

  it('trims the title, so whitespace cannot masquerade as a value', () => {
    expect(createDocumentSchema.parse({ title: '  Notes  ', content: 'x' }).title).toBe('Notes');
  });

  it('rejects an empty or whitespace-only title', () => {
    expect(createDocumentSchema.safeParse({ title: '', content: 'x' }).success).toBe(false);
    expect(createDocumentSchema.safeParse({ title: '   ', content: 'x' }).success).toBe(false);
  });

  it('caps content at 1MB, so one request cannot exhaust the embedding budget', () => {
    expect(
      createDocumentSchema.safeParse({ title: 'x', content: 'a'.repeat(1_000_001) }).success,
    ).toBe(false);
  });

  it('caps the number of tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
    expect(createDocumentSchema.safeParse({ title: 'x', content: 'x', tags }).success).toBe(false);
  });
});

describe('updateDocumentSchema', () => {
  it('rejects an empty patch rather than performing a no-op write', () => {
    expect(updateDocumentSchema.safeParse({}).success).toBe(false);
  });

  it('allows updating a single field', () => {
    expect(updateDocumentSchema.safeParse({ title: 'New' }).success).toBe(true);
  });

  it('rejects blanking the content; deleting the document is the way to empty it', () => {
    expect(updateDocumentSchema.safeParse({ content: '' }).success).toBe(false);
  });
});

describe('listDocumentsQuerySchema', () => {
  it('coerces query-string numbers, which arrive as strings', () => {
    const r = listDocumentsQuerySchema.parse({ limit: '10', offset: '20' });
    expect(r).toMatchObject({ limit: 10, offset: 20 });
  });

  it('applies defaults when the query is empty', () => {
    expect(listDocumentsQuerySchema.parse({})).toMatchObject({ limit: 50, offset: 0 });
  });

  it('caps limit so a client cannot request the whole table', () => {
    expect(listDocumentsQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });

  it('rejects a negative offset', () => {
    expect(listDocumentsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});

describe('askSchema', () => {
  it('requires a non-empty question', () => {
    expect(askSchema.safeParse({ question: '   ' }).success).toBe(false);
  });

  it('caps question length', () => {
    expect(askSchema.safeParse({ question: 'a'.repeat(2001) }).success).toBe(false);
  });

  it('rejects a malformed conversation id', () => {
    expect(askSchema.safeParse({ question: 'hi', conversationId: 'nope' }).success).toBe(false);
  });
});

describe('streamEventSchema', () => {
  it('accepts each event in the protocol', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const events = [
      { type: 'start', conversationId: id, messageId: id },
      { type: 'status', stage: 'retrieving' },
      { type: 'token', delta: 'hello' },
      { type: 'citations', citations: [] },
      { type: 'usage', promptTokens: 1, completionTokens: 2, provider: 'fake', model: 'm' },
      { type: 'done', messageId: id },
      { type: 'error', code: 'provider_timeout', message: 'timed out' },
    ];
    for (const e of events) {
      expect(streamEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    }
  });

  it('rejects an unknown event type, so the client never sees an unhandled case', () => {
    expect(streamEventSchema.safeParse({ type: 'mystery' }).success).toBe(false);
  });

  it('requires a terminal error to carry a code the client can switch on', () => {
    expect(streamEventSchema.safeParse({ type: 'error', message: 'x' }).success).toBe(false);
  });
});

describe('problemDetailsSchema', () => {
  it('accepts an RFC 9457 payload with field errors', () => {
    const r = problemDetailsSchema.safeParse({
      type: '/errors/validation_failed',
      title: 'Validation failed',
      status: 400,
      code: 'validation_failed',
      errors: { title: ['Title is required'] },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown error code, keeping the client contract closed', () => {
    expect(
      problemDetailsSchema.safeParse({ type: 't', title: 'x', status: 400, code: 'made_up' })
        .success,
    ).toBe(false);
  });
});

describe('refusal detection', () => {
  it('recognises the contract sentence', () => {
    expect(isNoAnswer(NO_ANSWER)).toBe(true);
  });

  it('tolerates the ways models reproduce a fixed sentence imperfectly', () => {
    expect(isNoAnswer('I couldn’t find that in your documents.')).toBe(true);
    expect(isNoAnswer("**I couldn't find that in your documents.**")).toBe(true);
    expect(isNoAnswer("I couldn't find that in your documents")).toBe(true);
    expect(isNoAnswer(`${NO_ANSWER} They cover deploys and on-call.`)).toBe(true);
    expect(isNoAnswer(`Sorry — ${NO_ANSWER}`)).toBe(true);
  });

  it('does not mistake a partial answer for a refusal', () => {
    // The sentence appearing late means the model answered something first.
    const partial = `Deploys take eight minutes [1]. As for rollbacks, ${NO_ANSWER}`;
    expect(isNoAnswer(partial)).toBe(false);
  });

  it('does not match an ordinary answer', () => {
    expect(isNoAnswer('Deploys take eight minutes [1].')).toBe(false);
  });
});

describe('classifyGrounding', () => {
  it('is grounded when the answer cites a provided source', () => {
    expect(classifyGrounding('Eight minutes [1].', 1)).toBe('grounded');
  });

  it('is a refusal when the answer says the documents do not cover it', () => {
    expect(classifyGrounding(NO_ANSWER, 0)).toBe('refusal');
  });

  it('is ungrounded when it neither cites nor refuses', () => {
    // The dangerous case: a confident answer with nothing behind it.
    expect(classifyGrounding('Paris is the capital of France.', 0)).toBe('ungrounded');
  });
});
