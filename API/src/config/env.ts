import { z } from 'zod';
import dotenv from 'dotenv';

// Load local development environment variables from `.env` if present.
// In production, variables should be provided by the process environment.
dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  // Single global shared secret used for config JWT verification and domain hashing.
  SHARED_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1).optional(),
  ACCESS_TOKEN_TTL: z.string().default('30m'),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | undefined;

export function getEnv(): Env {
  cachedEnv ??= EnvSchema.parse(process.env);
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
