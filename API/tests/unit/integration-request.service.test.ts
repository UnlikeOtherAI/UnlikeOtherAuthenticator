import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  findOpenIntegrationRequest,
  upsertPendingIntegrationRequest,
} from '../../src/services/integration-request.service.js';

const jwk = {
  kty: 'RSA' as const,
  kid: 'kid-1',
  n: 'nnn',
  e: 'AQAB',
};

function makePrisma(findFirst: ReturnType<typeof vi.fn>, extras?: Partial<PrismaClient['clientDomainIntegrationRequest']>): PrismaClient {
  return {
    clientDomainIntegrationRequest: {
      findFirst,
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new-id', ...data })),
      update: vi.fn().mockImplementation(({ where, data }) =>
        Promise.resolve({ id: where.id, ...data }),
      ),
      ...extras,
    },
  } as unknown as PrismaClient;
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
