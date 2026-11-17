/**
 * HTTP building blocks shared by every route: request context, authentication, authorization,
 * validation, idempotency and error handling.
 *
 * Order matters. In app.ts these run as:
 *   context → request log → auth → route (validate → idempotency → handler) → error handler
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { IdempotencyService } from '../application/idempotency';
import type { ApiToken, Role } from '../shared/config';
import { currentContext, isValidCorrelationId, newCorrelationId, runWithContext } from '../shared/context';
import {
  AppError,
  ForbiddenError,
  TransientError,
  UnauthorizedError,
  ValidationError,
} from '../shared/errors';

export interface Principal {
  subject: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
    principal?: Principal;
  }
}

/**
 * 1. Correlation ID + async context.
 * Accepts the caller's X-Correlation-Id (so traces span systems) if it is well-formed; otherwise
 * generates one. It is echoed back in the response header so a client can quote it to support.
 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-correlation-id');
    const id = incoming && isValidCorrelationId(incoming) ? incoming : newCorrelationId();
    req.correlationId = id;
    res.setHeader('X-Correlation-Id', id);
    runWithContext({ correlationId: id, actor: 'anonymous' }, () => next());
  };
}

/** 2. One log line per request: method, path, status, duration. Never bodies (they may contain sensitive data). */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) },
        'http request',
      );
    });
    next();
  };
}

/**
 * 3. Authentication: "Authorization: Bearer <token>".
 * Tokens are compared as SHA-256 digests with timingSafeEqual. WHY: a normal === comparison stops at
 * the first different character. By measuring response times, an attacker could guess a token one
 * character at a time. Constant-time comparison removes that signal.
 */
export function authenticate(tokens: ApiToken[]): RequestHandler {
  const digests = tokens.map((t) => ({ ...t, digest: createHash('sha256').update(t.token).digest() }));
  return (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return next(new UnauthorizedError());
    const presented = createHash('sha256').update(match[1]!).digest();
    const found = digests.find((t) => timingSafeEqual(t.digest, presented));
    if (!found) return next(new UnauthorizedError());
    req.principal = { subject: found.subject, role: found.role };
    const ctx = currentContext();
    if (ctx) ctx.actor = `${found.role}:${found.subject}`;
    next();
  };
}

/** 4. Authorization: only the listed roles may call the route. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.principal) return next(new UnauthorizedError());
    if (!roles.includes(req.principal.role)) return next(new ForbiddenError());
    next();
  };
}

/** Validates data against a Zod schema and returns the typed result, or throws a 400 with the details. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(
      'Request validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Wraps a handler so it runs at most once per Idempotency-Key (see application/idempotency.ts).
 * The handler returns { status, body } instead of writing to `res`, so the result can be stored
 * and replayed.
 */
export function idempotent(
  service: IdempotencyService,
  operation: string,
  handler: (req: Request) => Promise<{ status: number; body: unknown }>,
): RequestHandler {
  return async (req, res) => {
    const key = req.header('idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new ValidationError(
        'A valid Idempotency-Key header (8-100 chars: letters, digits, _ or -) is required',
      );
    }
    // The payload includes the caller, so two users cannot collide on the same key.
    const payload = { params: req.params, body: req.body, subject: req.principal?.subject };
    const result = await service.execute(operation, `${req.principal?.subject}:${key}`, payload, () =>
      handler(req),
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  };
}

/** Last middleware: converts any error into a consistent JSON response. */
export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Body-parser errors (malformed JSON) come with a 400 status.
    const parseError = (err as { type?: string; status?: number })?.type === 'entity.parse.failed';
    const appErr =
      err instanceof AppError
        ? err
        : parseError
          ? new ValidationError('Malformed JSON body')
          : new AppError('INTERNAL_ERROR', 'An unexpected error occurred', 500);

    if (appErr.httpStatus >= 500) logger.error({ err, code: appErr.code }, 'request failed');
    else logger.warn({ code: appErr.code, reason: appErr.message }, 'request rejected');

    // Tell well-behaved clients how long to wait before retrying.
    if (appErr instanceof TransientError && appErr.retryAfterMs) {
      res.setHeader('Retry-After', Math.ceil(appErr.retryAfterMs / 1000));
    }
    res.status(appErr.httpStatus).json({
      error: {
        code: appErr.code,
        // For 500s we hide internal messages (they could reveal implementation details).
        message:
          appErr.httpStatus >= 500 && !(err instanceof AppError)
            ? 'An unexpected error occurred'
            : appErr.message,
        details: appErr.details,
        correlationId: req.correlationId,
      },
    });
  };
}
