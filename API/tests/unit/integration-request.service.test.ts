import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  declineIntegrationRequest,
  deleteIntegrationRequest,
  findOpenIntegrationRequest,
  getIntegrationRequestById,
  listIntegrationRequests,
  upsertPendingIntegrationRequest,
} from '../../src/services/integration-request.service.js';

const jwk = {
  kty: 'RSA' as const,
  kid: 'kid-1',
  n: 'nnn',
  e: 'AQAB',
};

function makePrisma(findFirst: ReturnType<typeof vi.fn>, extras?: Partial<PrismaClient['clientDomainIntegrationRequest']>): PrismaClient & { __auditCreate: ReturnType<typeof vi.fn> } {
  const auditCreate = vi.fn().mockResolvedValue({});
  const client = {
    clientDomainIntegrationRequest: {
      findFirst,
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new-id', ...data })),
      update: vi.fn().mockImplementation(({ where, data }) =>
        Promise.resolve({ id: where.id, ...data }),
      ),
      delete: vi.fn().mockImplementation(({ where }) => Promise.resolve({ id: where.id })),
      ...extras,
    },
    adminAuditLog: { create: auditCreate },
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client)),
    __auditCreate: auditCreate,
  };
  return client as unknown as PrismaClient & { __auditCreate: ReturnType<typeof vi.fn> };
}

describe('findOpenIntegrationRequest', () => {
  it('normalizes the domain and filters to PENDING or DECLINED', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = makePrisma(findFirst);

    await findOpenIntegrationRequest('Client.Example.COM.', { prisma });

    expect(findFirst).toHaveBeenCalledWith({
      where: { domain: 'client.example.com', status: { in: ['PENDING', 'DECLINED'] } },
    });
  });

  it('returns null when no row exists', async () => {
    const prisma = makePrisma(vi.fn().mockResolvedValue(null));
    await expect(findOpenIntegrationRequest('client.example.com', { prisma })).resolves.toBeNull();
  });
});

describe('upsertPendingIntegrationRequest', () => {
  const base = {
    domain: 'client.example.com',
    kid: 'kid-1',
    publicJwk: jwk,
    jwkFingerprint: 'fp-hash',
    jwksUrl: 'https://client.example.com/jwks.json',
    configUrl: 'https://client.example.com/config',
    contactEmail: 'ops@client.example.com',
  } as const;

  it('creates a new pending row when none exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = makePrisma(findFirst);

    const outcome = await upsertPendingIntegrationRequest({ ...base }, { prisma });

    expect(outcome.kind).toBe('created');
    expect(prisma.clientDomainIntegrationRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        domain: 'client.example.com',
        status: 'PENDING',
        kid: 'kid-1',
        jwksUrl: 'https://client.example.com/jwks.json',
        contactEmail: 'ops@client.example.com',
      }),
    });
  });

  it('reports unchanged when the existing pending row matches fingerprint and metadata', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'req-1',
      domain: 'client.example.com',
      status: 'PENDING',
      kid: 'kid-1',
      jwkFingerprint: 'fp-hash',
      jwksUrl: 'https://client.example.com/jwks.json',
      contactEmail: 'ops@client.example.com',
      publicJwk: jwk,
    });
    const prisma = makePrisma(findFirst);

    const outcome = await upsertPendingIntegrationRequest({ ...base }, { prisma });

    expect(outcome.kind).toBe('unchanged');
    expect(prisma.clientDomainIntegrationRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { lastSeenAt: expect.any(Date) },
    });
    expect(prisma.clientDomainIntegrationRequest.create).not.toHaveBeenCalled();
  });

  it('updates in place when the fingerprint changes on an existing pending row', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'req-1',
      domain: 'client.example.com',
      status: 'PENDING',
      kid: 'kid-0-old',
      jwkFingerprint: 'fp-old',
      jwksUrl: 'https://client.example.com/jwks.json',
      contactEmail: 'ops@client.example.com',
      publicJwk: jwk,
    });
    const prisma = makePrisma(findFirst);

    const outcome = await upsertPendingIntegrationRequest({ ...base }, { prisma });

    expect(outcome.kind).toBe('updated');
    expect(prisma.clientDomainIntegrationRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: expect.objectContaining({
        kid: 'kid-1',
        jwkFingerprint: 'fp-hash',
      }),
    });
  });
});

describe('listIntegrationRequests', () => {
  it('queries newest-first with no status filter by default', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = makePrisma(vi.fn(), { findMany } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    await listIntegrationRequests({}, { prisma });

    expect(findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { submittedAt: 'desc' },
      take: 100,
    });
  });

  it('passes the status filter and clamps the limit', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = makePrisma(vi.fn(), { findMany } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    await listIntegrationRequests({ status: 'PENDING', limit: 1000 }, { prisma });

    expect(findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
      orderBy: { submittedAt: 'desc' },
      take: 200,
    });
  });
});

describe('getIntegrationRequestById', () => {
  it('returns the row when it exists', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'req-1', domain: 'client.example.com' });
    const prisma = makePrisma(vi.fn(), { findUnique } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    const row = await getIntegrationRequestById('req-1', { prisma });
    expect(row).toMatchObject({ id: 'req-1' });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'req-1' } });
  });

  it('returns null when the row is missing', async () => {
    const prisma = makePrisma(vi.fn(), {
      findUnique: vi.fn().mockResolvedValue(null),
    } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    await expect(getIntegrationRequestById('missing', { prisma })).resolves.toBeNull();
  });
});

describe('declineIntegrationRequest', () => {
  it('rejects when the row does not exist', async () => {
    const prisma = makePrisma(vi.fn(), {
      findUnique: vi.fn().mockResolvedValue(null),
    } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    await expect(
      declineIntegrationRequest(
        { id: 'missing', reason: 'spam', reviewerEmail: 'admin@example.com' },
        { prisma },
      ),
    ).rejects.toMatchObject({ statusCode: 404, message: 'INTEGRATION_REQUEST_NOT_FOUND' });
  });

  it('rejects when the row is not PENDING', async () => {
    const prisma = makePrisma(vi.fn(), {
      findUnique: vi.fn().mockResolvedValue({ id: 'req-1', status: 'DECLINED' }),
    } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    await expect(
      declineIntegrationRequest(
        { id: 'req-1', reason: 'spam', reviewerEmail: 'admin@example.com' },
        { prisma },
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'INTEGRATION_REQUEST_NOT_PENDING' });
  });

  it('updates status to DECLINED with reason + reviewer and writes an audit log inside the transaction', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      domain: 'client.example.com',
    });
    const update = vi.fn().mockImplementation(({ where, data }) => ({
      id: where.id,
      domain: 'client.example.com',
      ...data,
    }));
    const prisma = makePrisma(vi.fn(), {
      findUnique,
      update,
    } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    const row = await declineIntegrationRequest(
      { id: 'req-1', reason: 'spam submission', reviewerEmail: 'admin@example.com' },
      { prisma },
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: expect.objectContaining({
        status: 'DECLINED',
        declineReason: 'spam submission',
        reviewedByEmail: 'admin@example.com',
        reviewedAt: expect.any(Date),
      }),
    });
    expect(row.status).toBe('DECLINED');
    expect(prisma.__auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorEmail: 'admin@example.com',
        action: 'integration.declined',
        targetDomain: 'client.example.com',
      }),
    });
  });
});

describe('deleteIntegrationRequest', () => {
  it('rejects when the row does not exist', async () => {
    const prisma = makePrisma(vi.fn(), {
      findUnique: vi.fn().mockResolvedValue(null),
    } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    await expect(
      deleteIntegrationRequest({ id: 'missing', actorEmail: 'admin@example.com' }, { prisma }),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'INTEGRATION_REQUEST_NOT_FOUND',
    });
  });

  it('rejects when the row is still PENDING', async () => {
    const prisma = makePrisma(vi.fn(), {
      findUnique: vi.fn().mockResolvedValue({ id: 'req-1', status: 'PENDING' }),
    } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    await expect(
      deleteIntegrationRequest({ id: 'req-1', actorEmail: 'admin@example.com' }, { prisma }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'INTEGRATION_REQUEST_STILL_PENDING',
    });
  });

  it('deletes a DECLINED row and writes an audit log inside the transaction', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'req-1', status: 'DECLINED', domain: 'c.example.com' });
    const del = vi.fn().mockResolvedValue({ id: 'req-1' });
    const prisma = makePrisma(vi.fn(), {
      findUnique,
      delete: del,
    } as Partial<PrismaClient['clientDomainIntegrationRequest']>);

    const row = await deleteIntegrationRequest(
      { id: 'req-1', actorEmail: 'admin@example.com' },
      { prisma },
    );
    expect(del).toHaveBeenCalledWith({ where: { id: 'req-1' } });
    expect(row.status).toBe('DECLINED');
    expect(prisma.__auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorEmail: 'admin@example.com',
        action: 'integration.deleted',
        targetDomain: 'c.example.com',
      }),
    });
  });
});
