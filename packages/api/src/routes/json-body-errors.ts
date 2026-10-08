/**
 * Answers a request body the JSON parser couldn't read, without repeating it.
 *
 * express.json() reports a malformed body as an error whose message quotes the
 * text it failed on, and Express's default handler prints that error's stack
 * to stderr. A saved login's password, sent malformed, reached the log that
 * way (PR #782 review). This answers with the status and the parser's error
 * type, and logs no more than that. An error that isn't the body parser's
 * passes on unchanged.
 *
 * Mounted once in mcp/server.ts, after the shared express.json(). Express
 * hands an error to the next error handler in the stack whatever its path, so
 * this one also covers the parsers registered earlier on single routes.
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/** body-parser marks its own errors with a type such as 'entity.parse.failed' and a 4xx status. */
function bodyParserError(error: unknown): { type: string; status: number } | null {
  if (!error || typeof error !== 'object') return null;
  const { type, status, statusCode } = error as {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const code =
    typeof status === 'number' ? status : typeof statusCode === 'number' ? statusCode : NaN;
  if (typeof type !== 'string' || !(code >= 400 && code < 500)) return null;
  return { type, status: code };
}

export function jsonBodyErrors(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const rejected = bodyParserError(error);
  if (!rejected) {
    next(error);
    return;
  }
  logger.warn('Request body rejected', {
    type: rejected.type,
    status: rejected.status,
    method: req.method,
    path: req.path,
  });
  if (res.headersSent) return;
  res
    .status(rejected.status)
    .json({ error: 'The request body could not be read', code: rejected.type });
}
