/**
 * Structured logger (pino).
 *
 * WHY structured (JSON) logs: in production, logs are searched by machines ("show every line with
 * correlationId=X"). JSON fields make that reliable. Plain text would need fragile regexes.
 *
 * WHY redaction: logs are copied to many systems and kept for a long time. Secrets and payment data
 * must NEVER reach them. pino's `redact` removes these paths before anything is written. This is a
 * safety net. We also avoid logging whole payloads in the first place.
 */
import pino, { type Logger } from 'pino';
import { currentContext } from './context';

/** Field paths that must never appear in logs. The '*' wildcard matches one level of nesting. */
/** Sensitive field names. Each is redacted at the top level AND one level deep ("*.name"). */
const SENSITIVE_FIELDS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'authorization',
  'cardNumber',
  'cvv',
  'accountNumber',
  'consumerSecret',
  'tokenSecret',
  'signature',
];

/** Field paths that must never appear in logs. The '*' wildcard matches one level of nesting. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-signature"]',
  'headers.authorization',
  ...SENSITIVE_FIELDS,
  ...SENSITIVE_FIELDS.map((f) => `*.${f}`),
];

export function createLogger(level = 'info', destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'northstar-middleware' },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      // mixin() runs for every log line and adds the current correlation ID and actor automatically.
      mixin() {
        const ctx = currentContext();
        return ctx ? { correlationId: ctx.correlationId, actor: ctx.actor } : {};
      },
    },
    destination,
  );
}
