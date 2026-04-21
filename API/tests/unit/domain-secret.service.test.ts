import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDomainClientHash,
  digestDomainClientHash,
  verifyDomainAuthToken,
} from '../../src/services/domain-secret.service.js';

describe('domain-secret.service', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
  });

  it('verifies a per-domain client hash without storing the raw hash as the credential', async () => {
    const clientHash = createDomainClientHash('Client.Example.com', 'client-secret-with-enough-length');
    const secretDigest = digestDomainClientHash(clientHash);
    const prisma = {
      clientDomain: {
        findUnique: async () => ({
          status: 'active',
          secrets: [{ hashPrefix: clientHash.slice(0, 12), secretDigest }],
        }),
      },
    };

    await expect(
      verifyDomainAuthToken(
        { domain: 'client.example.com', token: clientHash },
        { prisma: prisma as never },
      ),
    ).resolves.toEqual({
      clientId: clientHash,
      domain: 'client.example.com',
      hashPrefix: clientHash.slice(0, 12),
    });
  });

  it('rejects disabled domains even when the hash digest matches', async () => {
    const clientHash = createDomainClientHash('client.example.com', 'client-secret-with-enough-length');
    const prisma = {
      clientDomain: {
        findUnique: async () => ({
          status: 'disabled',
          secrets: [{ hashPrefix: clientHash.slice(0, 12), secretDigest: digestDomainClientHash(clientHash) }],
        }),
      },
    };

    await expect(
      verifyDomainAuthToken(
        { domain: 'client.example.com', token: clientHash },
        { prisma: prisma as never },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
