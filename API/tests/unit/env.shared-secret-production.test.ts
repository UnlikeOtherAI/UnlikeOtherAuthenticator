import { describe, expect, it } from 'vitest';

import { parseEnv } from '../../src/config/env.js';

// Minimal valid env, copied from env.test.ts's baseInput — that helper is not
// exported, and duplicating it keeps this focused regression test self-contained.
function baseInput(overrides?: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    ADMIN_ACCESS_TOKEN_SECRET: 'admin-token-secret-with-enough-length',
    CONFIG_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
    CONFIG_JWKS_JSON: '{"keys":[{"kty":"RSA","kid":"test","n":"abc","e":"AQAB"}]}',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    REFRESH_TOKEN_TTL_DAYS: '30',
    LOG_RETENTION_DAYS: '90',
    ...overrides,
  };
}

describe('env: production SHARED_SECRET hardening (superRefine)', () => {
  it('rejects a production env whose SHARED_SECRET is 32-47 characters', () => {
    // 40 chars: clears the base 32-char floor but not the production 48-char rule.
    const shortSecret = 'k'.repeat(32) + 'abcdefgh';
    expect(shortSecret).toHaveLength(40);

    expect(() =>
      parseEnv(baseInput({ NODE_ENV: 'production', SHARED_SECRET: shortSecret })),
    ).toThrow();
  });

  it('rejects a production env whose SHARED_SECRET is long but degenerate (few distinct characters)', () => {
    // 64 chars of one character: long enough, but only 1 distinct character (< 16).
    const degenerateSecret = 'a'.repeat(64);

    expect(() =>
      parseEnv(baseInput({ NODE_ENV: 'production', SHARED_SECRET: degenerateSecret })),
    ).toThrow();
  });

  it('accepts a production env with a proper random 48+ character SHARED_SECRET', () => {
    // 64 chars drawn from a 30-character alphabet: length and entropy both pass.
    const goodSecret = 'n7Kq2wXv8pLm4zRt6yHd1cFs0bJe5uGa3iVo9xMkQWn7Kq2wXv8pLm4zRt6y';

    const env = parseEnv(baseInput({ NODE_ENV: 'production', SHARED_SECRET: goodSecret }));

    expect(env.SHARED_SECRET).toBe(goodSecret);
  });

  it('still accepts a 32-character SHARED_SECRET outside production', () => {
    const secret = 'x'.repeat(32);

    const env = parseEnv(baseInput({ NODE_ENV: 'test', SHARED_SECRET: secret }));

    expect(env.SHARED_SECRET).toBe(secret);
  });
});
