import { describe, expect, it } from 'vitest';

import { parseEnv } from '../../src/config/env.js';

function baseInput(overrides?: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    LOG_RETENTION_DAYS: '90',
    ...overrides,
  };
}

describe('env', () => {
  it('accepts ses as EMAIL_PROVIDER', () => {
    const env = parseEnv(baseInput({ EMAIL_PROVIDER: 'ses', AWS_REGION: 'eu-west-1' }));
    expect(env.EMAIL_PROVIDER).toBe('ses');
    expect(env.AWS_REGION).toBe('eu-west-1');
  });

  it('rejects unsupported EMAIL_PROVIDER values', () => {
    expect(() => parseEnv(baseInput({ EMAIL_PROVIDER: 'mailgun' }))).toThrow();
  });

  it('accepts ACCESS_TOKEN_TTL in the 15m-60m window (inclusive)', () => {
    expect(parseEnv(baseInput({ ACCESS_TOKEN_TTL: '15m' })).ACCESS_TOKEN_TTL).toBe('15m');
    expect(parseEnv(baseInput({ ACCESS_TOKEN_TTL: '60m' })).ACCESS_TOKEN_TTL).toBe('60m');
    expect(parseEnv(baseInput({ ACCESS_TOKEN_TTL: '30m' })).ACCESS_TOKEN_TTL).toBe('30m');
  });

  it('trims ACCESS_TOKEN_TTL', () => {
    expect(parseEnv(baseInput({ ACCESS_TOKEN_TTL: ' 30m ' })).ACCESS_TOKEN_TTL).toBe('30m');
  });

  it('rejects ACCESS_TOKEN_TTL outside the allowed window', () => {
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '14m' }))).toThrow();
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '61m' }))).toThrow();
  });

  it('rejects non-minute formats for ACCESS_TOKEN_TTL', () => {
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '1800s' }))).toThrow();
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '1h' }))).toThrow();
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '30' }))).toThrow();
  });
});
