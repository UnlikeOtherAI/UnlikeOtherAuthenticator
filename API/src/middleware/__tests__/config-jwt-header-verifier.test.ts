import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configJwtHeaderVerifier } from '../config-jwt-header-verifier.js';

const configService = vi.hoisted(() => ({
  validateConfigFields: vi.fn(),
  verifyConfigJwtSignatureWithKeyDomain: vi.fn(),
}));

vi.mock('../../services/config.service.js', () => configService);

function request(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('config JWT header verifier', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalConfigJwksUrl = process.env.CONFIG_JWKS_URL;

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('CONFIG_JWKS_URL', originalConfigJwksUrl);
  });

  it('requires the signing key domain to match the config domain', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    configService.verifyConfigJwtSignatureWithKeyDomain.mockResolvedValue({
      payload: { domain: 'victim.example.com' },
      keyDomain: 'attacker.example.com',
    });
    configService.validateConfigFields.mockReturnValue({ domain: 'victim.example.com' });

    await expect(
      configJwtHeaderVerifier(request({ 'x-uoa-config-jwt': 'jwt' }), {} as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects deployment-level fallback keys when the database is enabled', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    configService.verifyConfigJwtSignatureWithKeyDomain.mockResolvedValue({
      payload: { domain: 'client.example.com' },
      keyDomain: null,
    });
    configService.validateConfigFields.mockReturnValue({ domain: 'client.example.com' });

    await expect(
      configJwtHeaderVerifier(request({ 'x-uoa-config-jwt': 'jwt' }), {} as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('attaches verified config when the key domain matches', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    const req = request({ 'x-uoa-config-jwt': 'jwt' });
    configService.verifyConfigJwtSignatureWithKeyDomain.mockResolvedValue({
      payload: { domain: 'client.example.com' },
      keyDomain: 'Client.Example.Com.',
    });
    configService.validateConfigFields.mockReturnValue({ domain: 'client.example.com' });

    await expect(configJwtHeaderVerifier(req, {} as never)).resolves.toBeUndefined();
    expect(req.config).toEqual({ domain: 'client.example.com' });
    expect(req.configJwt).toBe('jwt');
  });
});
