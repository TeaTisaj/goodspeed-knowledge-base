import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@kb/contracts';

/**
 * Domain errors carrying a stable machine-readable code.
 *
 * The code is the contract the web app switches on; the message is for humans
 * and may change freely without breaking a client.
 */
export class AppError extends HttpException {
  readonly code: ErrorCode;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(
    code: ErrorCode,
    status: HttpStatus,
    message: string,
    fieldErrors?: Record<string, string[]>,
  ) {
    super(message, status);
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  static notFound(what: string): AppError {
    // Deliberately identical whether the row is missing or simply invisible
    // under RLS. Distinguishing them would leak the existence of other users'
    // documents through a 403-vs-404 side channel.
    return new AppError('not_found', HttpStatus.NOT_FOUND, `${what} not found`);
  }

  static validation(message: string, fieldErrors?: Record<string, string[]>): AppError {
    return new AppError('validation_failed', HttpStatus.BAD_REQUEST, message, fieldErrors);
  }

  static internal(message = 'Something went wrong'): AppError {
    return new AppError('internal_error', HttpStatus.INTERNAL_SERVER_ERROR, message);
  }
}
