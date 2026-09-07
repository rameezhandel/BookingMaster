import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { currentTenant } from '../db/tenant-context';

const SLOW_REQUEST_MS = 1_000;
const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * One line per request, structured in production so a log aggregator can filter
 * on tenant or request id, human-readable in development.
 *
 * Query strings are deliberately not logged: they carry customer phone numbers
 * through the search endpoints.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.write(req, res.statusCode, started),
        error: (err) => this.write(req, err?.status ?? 500, started),
      }),
    );
  }

  private write(req: Request, status: number, started: number) {
    const durationMs = Date.now() - started;
    const entry = {
      method: req.method,
      path: req.route?.path ?? req.path,
      status,
      durationMs,
      requestId: req.id,
      tenantId: currentTenant()?.tenantId,
    };

    if (isProduction()) {
      this.logger.log(JSON.stringify(entry));
      return;
    }

    const line = `${entry.method} ${entry.path} ${status} ${durationMs}ms`;
    if (durationMs > SLOW_REQUEST_MS) this.logger.warn(`${line}  (slow)`);
    else this.logger.log(line);
  }
}
