import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { digestApiKey, API_KEY_PREFIX } from '../../src/utils/api-key.js';

const adminApiKey = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(() => ({ adminApiKey })),
  getAdminPrisma: vi.fn(() => ({ adminApiKey })),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/db/prisma.js', () => prismaMocks);

const sharedSecret = 'test-shared-secret-with-enough-length';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('admin-api-key.service', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.DATABASE_URL = 'postgres://localhost/test';
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
  });

  it('createAdminApiKey returns the plaintext once and stores its digest', async () => {
    let storedDigest = '';
    adminApiKey.create.mockImplementation(async (args: { data: { secretDigest: string } }) => {
      storedDigest = args.data.secretDigest;
      return { id: 'key_1', name: 'ci', keyPrefix: 'uoa_ak_xxx', lastUsedAt: null, expiresAt: null, revokedAt: null, createdByEmail: null, createdAt: new Date() };
    });

    const { createAdminApiKey } = await import('../../src/services/admin-api-key.service.js');
    const { record, plaintext } = await createAdminApiKey({ name: 'ci' });

    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(record.id).toBe('key_1');
    // The persisted digest must be the HMAC of the plaintext — the secret itself is never stored.
    expect(storedDigest).toBe(digestApiKey(plaintext));
  });

  it('verifyAdminApiKey resolves { id } for an active key and touches lastUsedAt', async () => {
    adminApiKey.findUnique.mockResolvedValue({ id: 'key_1', revokedAt: null, expiresAt: null });
    adminApiKey.update.mockResolvedValue({});

    const { verifyAdminApiKey } = await import('../../src/services/admin-api-key.service.js');
    const result = await verifyAdminApiKey('uoa_ak_anything');

    expect(result).toEqual({ id: 'key_1' });
    expect(adminApiKey.update).toHaveBeenCalledWith({ where: { id: 'key_1' }, data: { lastUsedAt: expect.any(Date) } });
  });

  it('verifyAdminApiKey rejects a revoked key with 401', async () => {
    adminApiKey.findUnique.mockResolvedValue({ id: 'key_1', revokedAt: new Date(), expiresAt: null });
    const { verifyAdminApiKey } = await import('../../src/services/admin-api-key.service.js');
    await expect(verifyAdminApiKey('uoa_ak_x')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('verifyAdminApiKey rejects an expired key with 401', async () => {
    adminApiKey.findUnique.mockResolvedValue({ id: 'key_1', revokedAt: null, expiresAt: new Date(Date.now() - 1000) });
    const { verifyAdminApiKey } = await import('../../src/services/admin-api-key.service.js');
    await expect(verifyAdminApiKey('uoa_ak_x')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('verifyAdminApiKey rejects an unknown key with 401', async () => {
    adminApiKey.findUnique.mockResolvedValue(null);
    const { verifyAdminApiKey } = await import('../../src/services/admin-api-key.service.js');
    await expect(verifyAdminApiKey('uoa_ak_x')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('verifyAdminApiKey rejects with 401 when DATABASE_URL is unset (DB-less guard)', async () => {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    const { verifyAdminApiKey } = await import('../../src/services/admin-api-key.service.js');
    await expect(verifyAdminApiKey('uoa_ak_x')).rejects.toMatchObject({ statusCode: 401 });
    expect(adminApiKey.findUnique).not.toHaveBeenCalled();
  });

  it('verifyAdminApiKey still succeeds when the lastUsedAt touch fails', async () => {
    adminApiKey.findUnique.mockResolvedValue({ id: 'key_1', revokedAt: null, expiresAt: null });
    adminApiKey.update.mockRejectedValue(new Error('db blip'));
    const { verifyAdminApiKey } = await import('../../src/services/admin-api-key.service.js');
    await expect(verifyAdminApiKey('uoa_ak_x')).resolves.toEqual({ id: 'key_1' });
  });
});
