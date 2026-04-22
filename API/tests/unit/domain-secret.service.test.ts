import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDomainClientHash,
  digestDomainClientHash,
} from '../../src/utils/client-hash.js';
import {
  rotateAdminDomainSecret,
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

  describe('rotateAdminDomainSecret', () => {
    // Regression guard for H3 (2026-04-22 audit). The rotate flow must never
    // reveal the raw client secret to the admin and must NOT deactivate the
    // currently active client_domain_secret row — that only happens when the
    // partner consumes the emailed claim link.

    function makeRotatePrisma(opts: {
      domain?: { id: string; domain: string } | null;
      integration?: { id: string; contactEmail: string } | null;
    }) {
      const claimCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'claim-1',
        ...data,
      }));
      const secretActivations = vi.fn();
      const claimDeleteMany = vi.fn(async () => ({ count: 0 }));
      const auditCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'aud-1', ...data }));

      const tx = {
        clientDomain: {
          findUnique: vi.fn(async () => opts.domain ?? null),
        },
        clientDomainIntegrationRequest: {
          findFirst: vi.fn(async () => opts.integration ?? null),
        },
        integrationClaimToken: {
          deleteMany: claimDeleteMany,
          create: claimCreate,
        },
        clientDomainSecret: {
          updateMany: secretActivations,
          create: secretActivations,
        },
        adminAuditLog: {
          create: auditCreate,
        },
      };
      const prisma = {
        $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
      };
      return { prisma, tx, secretActivations, claimCreate, auditCreate, claimDeleteMany };
    }

    it('throws DOMAIN_NOT_FOUND when the client domain is missing', async () => {
      const { prisma } = makeRotatePrisma({ domain: null });
      await expect(
        rotateAdminDomainSecret(
          { domain: 'unknown.example.com', actorEmail: 'admin@example.com' },
          { prisma: prisma as never, sharedSecret: 'test-shared-secret-with-enough-length' },
        ),
      ).rejects.toMatchObject({ statusCode: 404, message: 'DOMAIN_NOT_FOUND' });
    });

    it('throws DOMAIN_HAS_NO_CLAIM_CONTACT when no accepted integration exists', async () => {
      const { prisma } = makeRotatePrisma({
        domain: { id: 'cd-1', domain: 'partner.example.com' },
        integration: null,
      });
      await expect(
        rotateAdminDomainSecret(
          { domain: 'partner.example.com', actorEmail: 'admin@example.com' },
          { prisma: prisma as never, sharedSecret: 'test-shared-secret-with-enough-length' },
        ),
      ).rejects.toMatchObject({ statusCode: 400, message: 'DOMAIN_HAS_NO_CLAIM_CONTACT' });
    });

    it('issues a claim token but does NOT activate the new secret until the partner claims', async () => {
      const { prisma, secretActivations, claimCreate, auditCreate, claimDeleteMany } = makeRotatePrisma({
        domain: { id: 'cd-1', domain: 'partner.example.com' },
        integration: { id: 'int-1', contactEmail: 'partner@example.com' },
      });

      const result = await rotateAdminDomainSecret(
        { domain: 'partner.example.com', actorEmail: 'admin@example.com' },
        { prisma: prisma as never, sharedSecret: 'test-shared-secret-with-enough-length' },
      );

      expect(result.domain).toBe('partner.example.com');
      expect(result.contactEmail).toBe('partner@example.com');
      expect(result.hashPrefix).toHaveLength(12);
      expect(result.claim.rawToken).toMatch(/^[A-Za-z0-9_-]+$/);

      // No client_domain_secret insert/update at rotate time — only on consume.
      expect(secretActivations).not.toHaveBeenCalled();

      // Outstanding unused claims are invalidated so only one live claim remains.
      expect(claimDeleteMany).toHaveBeenCalledWith({
        where: { integrationId: 'int-1', usedAt: null },
      });

      // Claim row is tagged to the client_domain so `consumeClaim` can rotate atomically.
      const claimData = claimCreate.mock.calls[0][0].data as { clientDomainId: string | null };
      expect(claimData.clientDomainId).toBe('cd-1');

      // Audit log is written inside the same transaction as the claim mint.
      expect(auditCreate).toHaveBeenCalledTimes(1);
      const auditData = auditCreate.mock.calls[0][0].data as { action: string };
      expect(auditData.action).toBe('domain.secret_rotated');
    });
  });
});
