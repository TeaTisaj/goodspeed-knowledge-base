import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ErrorCode, ProblemDetails } from '@kb/contracts';
import { AiProviderError } from '@kb/ai';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

/**
 * Maps every thrown value to RFC 9457 problem+json.
 *
 * Two rules worth stating:
 *  - Unexpected errors log their detail and return a generic message. Echoing
 *    an internal error to the client leaks stack shapes and query structure.
 *  - If the response has already started (a stream), nothing can be changed —
 *    status and headers are long gone. The stream layer emits an SSE `error`
 *    event instead; here we only avoid corrupting the response.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      this.logger.error(
        `Error after response started: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
      response.end();
      return;
    }

    const problem = this.toProblem(exception);
    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof AppError) {
      return {
        type: `https://goodspeed.kb/errors/${exception.code}`,
        title: exception.message,
        status: exception.getStatus(),
        code: exception.code,
        ...(exception.fieldErrors ? { errors: exception.fieldErrors } : {}),
      };
    }

    if (exception instanceof ZodError) {
      const errors: Record<string, string[]> = {};
      for (const issue of exception.issues) {
        const key = issue.path.join('.') || '_';
        (errors[key] ??= []).push(issue.message);
      }
      return {
        type: 'https://goodspeed.kb/errors/validation_failed',
        title: 'Validation failed',
        status: HttpStatus.BAD_REQUEST,
        code: 'validation_failed',
        errors,
      };
    }

    if (exception instanceof AiProviderError) {
      const { status, code } = mapProviderError(exception);
      this.logger.warn(`Provider ${exception.providerId} failed: ${exception.message}`);
      return {
        type: `https://goodspeed.kb/errors/${code}`,
        // The upstream vendor message is not shown to the user; it frequently
        // contains account and quota detail that is not theirs to see.
        title:
          code === 'provider_timeout'
            ? 'The AI provider timed out'
            : 'The AI provider is unavailable',
        status,
        code,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = statusToCode(status);
      return {
        type: `https://goodspeed.kb/errors/${code}`,
        title: exception.message,
        status,
        code,
      };
    }

    // Errors raised by Express middleware before Nest sees the request --
    // body-parser's "request entity too large", for one -- are `http-errors`
    // objects, not HttpExceptions. They carry a client status and `expose`,
    // meaning the message is safe to show. Treating them as unhandled turned a
    // too-large document into a 500.
    const httpError = exception as { status?: unknown; expose?: unknown; message?: unknown };
    if (
      typeof httpError?.status === 'number' &&
      httpError.status >= 400 &&
      httpError.status < 500 &&
      httpError.expose === true
    ) {
      const code = statusToCode(httpError.status);
      return {
        type: `https://goodspeed.kb/errors/${code}`,
        title:
          httpError.status === HttpStatus.PAYLOAD_TOO_LARGE
            ? 'Request is too large'
            : String(httpError.message ?? 'Bad request'),
        status: httpError.status,
        code,
      };
    }

    this.logger.error(`Unhandled: ${(exception as Error)?.message}`, (exception as Error)?.stack);
    return {
      type: 'https://goodspeed.kb/errors/internal_error',
      title: 'Something went wrong',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal_error',
    };
  }
}

function mapProviderError(e: AiProviderError): { status: number; code: ErrorCode } {
  switch (e.code) {
    case 'rate_limit':
      return { status: HttpStatus.TOO_MANY_REQUESTS, code: 'rate_limited' };
    case 'timeout':
      return { status: HttpStatus.GATEWAY_TIMEOUT, code: 'provider_timeout' };
    case 'context_length':
      return { status: HttpStatus.BAD_REQUEST, code: 'validation_failed' };
    default:
      // An upstream auth failure is our misconfiguration, not the caller's, so
      // it must never surface as 401 and prompt them to sign in again.
      return { status: HttpStatus.BAD_GATEWAY, code: 'provider_unavailable' };
  }
}

function statusToCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'forbidden';
    case HttpStatus.NOT_FOUND:
      return 'not_found';
    case HttpStatus.CONFLICT:
      return 'conflict';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'payload_too_large';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'rate_limited';
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return 'validation_failed';
    default:
      return 'internal_error';
  }
}
