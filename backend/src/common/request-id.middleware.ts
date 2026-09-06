import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    id?: string;
  }
}

/** Only accept an inbound id that is safe to echo into a header and a log line. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Gives every request an id, reusing an upstream one where a proxy supplied it
 * so a trace survives the hop, and echoing it back so a user reporting "it
 * failed" can be matched to the exact request in the logs.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}
