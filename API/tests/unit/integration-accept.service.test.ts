import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptIntegrationRequest,
  resendIntegrationClaim,
} from '../../src/services/integration-accept.service.js';
import { encryptClaimSecret } from '../../src/utils/claim-secret-crypto.js';

const sharedSecret = 'test-shared-secret-with-enough-length';

type IntegrationRow = {
  id: string;
  domain: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  contactEmail: string;
  publicJwk: { kty: 'RSA'; kid: string; n: string; e: string };
  jwkFingerprint: string;
  kid: string;
  jwksUrl: string;
  configUrl: string | null;
  configSummary: null;
  preValidationResult: null;
  declineReason: null;
  reviewedAt: Date | null;
  reviewedByEmail: string | null;
  clientDomainId: string | null;
  submittedAt: Date;
  lastSeenAt: Date;
};

type ClaimRow = {
  id: string;
  integrationId: string;
  tokenHash: string;
  encryptedSecret: Uint8Array | null;
  encryptionIv: Uint8Array | null;
  encryptionTag: Uint8Array | null;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

function baseRow(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: 'req-1',
    domain: 'client.example.com',
    status: 'PENDING',
    contactEmail: 'ops@client.example.com',
    publicJwk: { kty: 'RSA', kid: 'kid-1', n: 'nnn', e: 'AQAB' },
    jwkFingerprint: 'fp-hash',
    kid: 'kid-1',
    jwksUrl: 'https://client.example.com/jwks.json',
    configUrl: 'https://client.example.com/config',
    configSummary: null,
    preValidationResult: null,
    declineReason: null,
    reviewedAt: null,
    reviewedByEmail: null,
    clientDomainId: null,
    submittedAt: new Date('2026-04-20T10:00:00Z'),
    lastSeenAt: new Date('2026-04-22T10:00:00Z'),
    ...overrides,
  };
}

function makePrisma(init: {
  integration: IntegrationRow | null;
  conflict?: { id: string } | null;
  claimTokens?: ClaimRow[];
}): {
  prisma: unknown;
  claimRows: ClaimRow[];
  domainCreate: ReturnType<typeof vi.fn>;
  auditCreate: ReturnType<typeof vi.fn>;
} {
  const integrationRow = init.integration;
  const claimRows = init.claimTokens ? [...init.claimTokens] : [];

  const domainCreate = vi.fn(async () => ({ id: 'cd-1' }));
  const auditCreate = vi.fn(async () => ({}));

  const tx = {
    clientDomainIntegrationRequest: {
      findUnique: vi.fn(async () => integrationRow),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<IntegrationRow> }) => ({
        ...(integrationRow as IntegrationRow),
        ...data,
        id: where.id,
      })),
    },
    clientDomain: {
      findUnique: vi.fn(async () => init.conflict ?? null),
      create: domainCreate,
    },
    clientDomainJwk: {},
    clientDomainSecret: {},
    adminAuditLog: { create: auditCreate },
    integrationClaimToken: {
      create: vi.fn(async ({ data }: { data: Omit<ClaimRow, 'id' | 'createdAt' | 'usedAt'> }) => {
        const row: ClaimRow = {
          id: `claim-${claimRows.length + 1}`,
          createdAt: new Date(),
          usedAt: null,
          ...data,
        } as ClaimRow;
        claimRows.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { integrationId: string; usedAt: null };
        }) =>
          claimRows.find(
            (r) => r.integrationId === where.integrationId && r.usedAt === null,
          ) ?? null,
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { integrationId: string; usedAt: null };
        }) => {
          const before = claimRows.length;
          for (let i = claimRows.length - 1; i >= 0; i -= 1) {
            if (
              claimRows[i].integrationId === where.integrationId &&
              claimRows[i].usedAt === null
            ) {
              claimRows.splice(i, 1);
            }
          }
          return { count: before - claimRows.length };
        },
      ),
    },
  };

  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (innerTx: unknown) => Promise<T>): Promise<T> => fn(tx),
  };

  return { prisma, claimRows, domainCreate, auditCreate };
}

describe('acceptIntegrationRequest', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
  });

  afterEach(() => {
    if (originalSharedSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    else process.env.SHARED_SECRET = originalSharedSecret;
  });

  it('creates a ClientDomain, writes a claim token, flips the request to ACCEPTED, and emits an audit log inside the tx', async () => {
    const { prisma, claimRows, domainCreate, auditCreate } = makePrisma({ integration: baseRow() });

    const result = await acceptIntegrationRequest(
      { id: 'req-1', reviewerEmail: 'admin@example.com', label: 'Client Inc' },
      { prisma: prisma as never, sharedSecret },
    );

    expect(domainCreate).toHaveBeenCalledTimes(1);
    const createArgs = domainCreate.mock.calls[0][0];
    expect(createArgs).toMatchObject({
      data: expect.objectContaining({
        domain: 'client.example.com',
        label: 'Client Inc',
        status: 'active',
      }),
    });

    expect(claimRows).toHaveLength(1);
    expect(claimRows[0].integrationId).toBe('req-1');
    expect(claimRows[0].encryptedSecret).toBeInstanceOf(Uint8Array);

    expect(result.integration.status).toBe('ACCEPTED');
    expect(result.integration.reviewedByEmail).toBe('admin@example.com');
    expect(result.rawClientSecret.length).toBeGreaterThanOrEqual(32);
    expect(result.clientHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.claim.rawToken).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorEmail: 'admin@example.com',
        action: 'integration.accepted',
        targetDomain: 'client.example.com',
      }),
    });
  });

  it('rejects when the request is already accepted', async () => {
    const { prisma } = makePrisma({ integration: baseRow({ status: 'ACCEPTED' }) });

    await expect(
      acceptIntegrationRequest(
        { id: 'req-1', reviewerEmail: 'admin@example.com' },
        { prisma: prisma as never, sharedSecret },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'INTEGRATION_REQUEST_NOT_PENDING' });
  });

  it('rejects when the domain already has a ClientDomain row', async () => {
    const { prisma } = makePrisma({
      integration: baseRow(),
      conflict: { id: 'cd-existing' },
    });

    await expect(
      acceptIntegrationRequest(
        { id: 'req-1', reviewerEmail: 'admin@example.com' },
        { prisma: prisma as never, sharedSecret },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'DOMAIN_ALREADY_EXISTS' });
  });

  it('rejects a too-short explicit clientSecret', async () => {
    const { prisma } = makePrisma({ integration: baseRow() });

    await expect(
      acceptIntegrationRequest(
        { id: 'req-1', reviewerEmail: 'admin@example.com', clientSecret: 'too-short' },
        { prisma: prisma as never, sharedSecret },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'CLIENT_SECRET_TOO_SHORT' });
  });
});

describe('resendIntegrationClaim', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
  });

  afterEach(() => {
    if (originalSharedSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    else process.env.SHARED_SECRET = originalSharedSecret;
  });

  it('decrypts the existing token secret, deletes it, and issues a fresh claim', async () => {
    const plaintext = 'the-real-client-secret-kept-the-same!!';
    const enc = encryptClaimSecret(plaintext, { sharedSecret });
    const existingClaim: ClaimRow = {
      id: 'claim-old',
      integrationId: 'req-1',
      tokenHash: 'old-hash',
      encryptedSecret: enc.ciphertext,
      encryptionIv: enc.iv,
      encryptionTag: enc.tag,
      expiresAt: new Date('2026-04-23T12:00:00Z'),
      usedAt: null,
      createdAt: new Date('2026-04-22T10:00:00Z'),
    };
    const { prisma, claimRows, auditCreate } = makePrisma({
      integration: baseRow({ status: 'ACCEPTED' }),
      claimTokens: [existingClaim],
    });

    const result = await resendIntegrationClaim(
      { id: 'req-1', actorEmail: 'admin@example.com' },
      { prisma: prisma as never, sharedSecret },
    );

    expect(result.integration.status).toBe('ACCEPTED');
    expect(result.claim.rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
    // Old row was deleted and a fresh one was created.
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0].id).not.toBe('claim-old');

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorEmail: 'admin@example.com',
        action: 'integration.claim_resent',
        targetDomain: 'client.example.com',
      }),
    });
  });

  it('rejects when no unused claim token remains (already claimed)', async () => {
    const { prisma } = makePrisma({
      integration: baseRow({ status: 'ACCEPTED' }),
      claimTokens: [],
    });

    await expect(
      resendIntegrationClaim(
        { id: 'req-1', actorEmail: 'admin@example.com' },
        { prisma: prisma as never, sharedSecret },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'CLAIM_ALREADY_CLAIMED' });
  });

  it('rejects when the integration is not yet ACCEPTED', async () => {
    const { prisma } = makePrisma({ integration: baseRow({ status: 'PENDING' }) });

    await expect(
      resendIntegrationClaim(
        { id: 'req-1', actorEmail: 'admin@example.com' },
        { prisma: prisma as never, sharedSecret },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'INTEGRATION_REQUEST_NOT_ACCEPTED' });
  });
});
