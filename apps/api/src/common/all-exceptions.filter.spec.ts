import { PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

/** Runs the filter against a recording response and returns what it sent. */
function send(exception: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return this;
    },
    type() {
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  new AllExceptionsFilter().catch(exception, host as never);
  return sent;
}

describe('AllExceptionsFilter', () => {
  it("maps body-parser's too-large error to 413, not 500", () => {
    // The shape `http-errors` produces; regression for documents over 100 kB
    // failing as internal errors.
    const bodyParserError = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const sent = send(bodyParserError);
    expect(sent.status).toBe(413);
    expect(sent.body).toMatchObject({ code: 'payload_too_large' });
  });

  it('maps an upload over the file limit to payload_too_large', () => {
    const sent = send(new PayloadTooLargeException('File too large'));
    expect(sent.status).toBe(413);
    expect(sent.body).toMatchObject({ code: 'payload_too_large' });
  });

  it('keeps an unexposed error generic, so internals never reach the client', () => {
    const internal = Object.assign(new Error('connection string postgres://secret@db'), {
      status: 400,
      expose: false,
    });
    const sent = send(internal);
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain('postgres://');
  });

  it('never echoes an unknown error message', () => {
    const sent = send(new Error('relation "chunks" does not exist'));
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain('relation');
  });
});
