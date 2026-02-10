import { z } from 'zod';
import dotenv from 'dotenv';

// Load local development environment variables from `.env` if present.
// In production, variables should be provided by the process environment.
dotenv.config();

function normalizeAccessTokenTtl(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  return input.trim();
}

function isValidAccessTokenTtl(value: string): boolean {
  // Brief 22.10 + task 1ac35cf5: access tokens must be short-lived (configurable, e.g. 15–60 minutes).
  // Enforce minutes-only format to avoid accidental long-lived tokens via "h/d" units.
  const match = value.match(/^(\d{1,3})m$/);
  if (!match) return false;

  const minutes = Number(match[1]);
  if (!Number.isInteger(minutes)) return false;
  return minutes >= 15 && minutes <= 60;
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Public origin used when generating links sent by email (magic links, verification, reset).
  // If unset, we fall back to `http://${HOST}:${PORT}`.
  PUBLIC_BASE_URL: z.string().min(1).optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  // Single global shared secret used for config JWT verification and domain hashing.
  SHARED_SECRET: z.string().min(1),
  // Identifier for this auth service instance. Used as expected `aud` for config JWTs.
  AUTH_SERVICE_IDENTIFIER: z.string().min(1),
  DATABASE_URL: z.string().min(1).optional(),
  // Social providers (one set of credentials for the auth service, not per-client).
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  FACEBOOK_CLIENT_ID: z.string().min(1).optional(),
  FACEBOOK_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  APPLE_CLIENT_ID: z.string().min(1).optional(),
  APPLE_TEAM_ID: z.string().min(1).optional(),
  APPLE_KEY_ID: z.string().min(1).optional(),
  // Apple private key contents (typically a .p8 PEM). May be provided with literal newlines
  // or with escaped newlines ("\\n") depending on the deployment environment.
  APPLE_PRIVATE_KEY: z.string().min(1).optional(),
  ACCESS_TOKEN_TTL: z.preprocess(
    normalizeAccessTokenTtl,
    z
      .string()
      .default('30m')
      .refine(isValidAccessTokenTtl, {
        message: 'ACCESS_TOKEN_TTL must be minutes-only between 15m and 60m (e.g. "30m")',
      }),
  ),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | undefined;

export function parseEnv(input: NodeJS.ProcessEnv): Env {
  return EnvSchema.parse(input);
}

export function getEnv(): Env {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}

export function requireEnv<K extends keyof Env>(...keys: K[]): Pick<Env, K> {
  const env = getEnv();
  const missing = keys.filter((k) => env[k] == null || env[k] === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return env as Pick<Env, K>;
}
