import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Postgres SQLSTATE codes we translate into meaningful HTTP responses. */
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

function isPgError(err: unknown): err is PgError {
  return err instanceof Error && typeof (err as PgError).code === 'string';
}

/**
 * The double-booking guard is a database constraint, so the *only* way the
 * application learns about a conflict is by catching its violation. Callers wrap
 * writes in this so a race surfaces as a clean 409 rather than a 500.
 */
export class SlotUnavailableError extends ConflictException {
  constructor(message = 'That slot has just been taken. Refresh the calendar and try again.') {
    super({ statusCode: 409, error: 'SlotUnavailable', message });
  }
}

/**
 * The court is shut at that time. Carries its own code so the UI can offer
 * "book anyway" rather than pattern-matching on prose.
 */
export class OutsideOpeningHoursError extends ConflictException {
  constructor(message: string) {
    super({ statusCode: 409, error: 'OutsideOpeningHours', message });
  }
}

export function rethrowAsHttp(err: unknown): never {
  if (err instanceof HttpException) throw err;

  if (isPgError(err)) {
    switch (err.code) {
      case PG_EXCLUSION_VIOLATION:
        throw new SlotUnavailableError();
      case PG_UNIQUE_VIOLATION:
        if (err.constraint === 'app_user_email_key') {
          throw new ConflictException('An account with that email already exists.');
        }
        if (err.constraint === 'customer_tenant_phone_key') {
          throw new ConflictException('A customer with that phone number already exists.');
        }
        throw new ConflictException('That record already exists.');
      default:
        break;
    }
  }
  throw err;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    let normalised: unknown = exception;
    try {
      rethrowAsHttp(exception);
    } catch (mapped) {
      normalised = mapped;
    }

    if (normalised instanceof HttpException) {
      const status = normalised.getStatus();
      if (status >= 500) this.logger.error(normalised.message, normalised.stack);
      res.status(status).json(normalised.getResponse());
      return;
    }

    this.logger.error(
      normalised instanceof Error ? normalised.message : String(normalised),
      normalised instanceof Error ? normalised.stack : undefined,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      error: 'InternalServerError',
      message: 'Something went wrong.',
    });
  }
}
