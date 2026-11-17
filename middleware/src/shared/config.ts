/**
 * Application configuration.
 *
 * WHY: Configuration (ports, credentials, modes) comes from environment variables so the same code
 * can run locally, in staging and in production without changes. We validate it ONCE at start-up with
 * Zod so a missing/invalid value fails immediately with a clear message — instead of failing later,
 * in the middle of a payment run, with a confusing error.
 */
import { z } from 'zod';

/** Roles used for authorization. Keeping them in one place avoids typos like "ap-maker" vs "ap_maker". */
export const ROLES = ['ap_maker', 'ap_checker', 'ar_clerk', 'ops', 'customer'] as const;
export type Role = (typeof ROLES)[number];

export interface ApiToken {
  token: string;
  role: Role;
  /** Who the token belongs to. For customers this is their NetSuite customer externalId. */
  subject: string;
}

/**
 * Parses "token:role:subject,token:role:subject" into objects.
 * WHY a simple static token list: it keeps the learning setup self-contained. In a real deployment you
 * would use an identity provider (OAuth 2.0 / OIDC) — see docs/architecture/security.md.
 */
function parseApiTokens(raw: string): ApiToken[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [token, role, subject] = entry.split(':');
      if (!token || !role || !subject || !(ROLES as readonly string[]).includes(role)) {
        throw new Error(`Invalid API_TOKENS entry "${entry}". Expected token:role:subject`);
      }
      return { token, role: role as Role, subject };
    });
}

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NETSUITE_MODE: z.enum(['mock', 'rest']).default('mock'),
  NETSUITE_ACCOUNT_ID: z.string().optional(),
  NETSUITE_CONSUMER_KEY: z.string().optional(),
  NETSUITE_CONSUMER_SECRET: z.string().optional(),
  NETSUITE_TOKEN_ID: z.string().optional(),
  NETSUITE_TOKEN_SECRET: z.string().optional(),
  STORAGE_MODE: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: z.string().optional(),
  // min(16): a short webhook secret is easy to brute-force, so we refuse to start with one.
  WEBHOOK_SIGNING_SECRET: z.string().min(16, 'WEBHOOK_SIGNING_SECRET must be at least 16 characters'),
  API_TOKENS: z.string().min(1),
  SFTP_ROOT: z.string().default('./runtime-data/sftp'),
  COMPANY_NAME: z.string().max(16).default('NORTHSTAR DIST'),
  COMPANY_ID: z
    .string()
    .regex(/^\d{10}$/, 'COMPANY_ID must be 10 digits')
    .default('1234567890'),
  ORIGIN_ROUTING: z
    .string()
    .regex(/^\d{9}$/, 'ORIGIN_ROUTING must be 9 digits')
    .default('110000000'),
});

export type AppConfig = Omit<z.infer<typeof ConfigSchema>, 'API_TOKENS'> & { API_TOKENS: ApiToken[] };

/**
 * Validates an environment object and returns typed config.
 * Takes `env` as a parameter (instead of reading process.env directly) so tests can pass fake values.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    // Report every problem at once, but never print the values (they may be secrets).
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const cfg = result.data;

  // Cross-field rules that a simple schema cannot express:
  if (cfg.NETSUITE_MODE === 'rest') {
    const required = [
      'NETSUITE_ACCOUNT_ID',
      'NETSUITE_CONSUMER_KEY',
      'NETSUITE_CONSUMER_SECRET',
      'NETSUITE_TOKEN_ID',
      'NETSUITE_TOKEN_SECRET',
    ] as const;
    const missing = required.filter((k) => !cfg[k]);
    if (missing.length)
      throw new Error(`Invalid configuration: NETSUITE_MODE=rest requires ${missing.join(', ')}`);
  }
  if (cfg.STORAGE_MODE === 'postgres' && !cfg.DATABASE_URL) {
    throw new Error('Invalid configuration: STORAGE_MODE=postgres requires DATABASE_URL');
  }

  return { ...cfg, API_TOKENS: parseApiTokens(cfg.API_TOKENS) };
}
