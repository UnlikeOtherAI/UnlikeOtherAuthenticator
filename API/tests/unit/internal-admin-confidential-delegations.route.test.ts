import { ConfidentialDelegationScope } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  listConfidentialDelegationMappings: vi.fn(),
  createConfidentialDelegationMapping: vi.fn(),
  updateConfidentialDelegationMapping: vi.fn(),
  deleteConfidentialDelegationMapping: vi.fn(),
}));

vi.mock('../../src/middleware/admin-superuser.js', () => ({
  requireAdminSuperuser: async (
    request: {
      headers: { authorization?: string };
      adminAccessTokenClaims?: { userId: string; email: string };
    },
    reply: {
      code: (statusCode: number) => {
        send: (body: unknown) => unknown;
      };
    },
  ) => {
    if (request.headers.authorization !== 'Bearer admin-token') {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    request.adminAccessTokenClaims = {
      userId: 'admin-1',
      email: 'admin@example.com',
    };
  },
}));

vi.mock('../../src/services/confidential-delegation.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/confidential-delegation.service.js')
  >('../../src/services/confidential-delegation.service.js');
  return { ...actual, ...service };
});

const row = {
  id: 'delegation-1',
  clientDomainId: 'client-domain-nessie',
  product: 'nessie',
  resource: 'https://ledger.unlikeotherai.com',
  scopes: [ConfidentialDelegationScope.AI_INVOKE],
  enabled: true,
  createdByEmail: 'admin@example.com',
  updatedByEmail: 'admin@example.com',
  createdAt: new Date('2026-07-19T10:00:00.000Z'),
  updatedAt: new Date('2026-07-19T10:00:00.000Z'),
  clientDomain: { domain: 'api.nessie.works', status: 'active' },
};

describe('internal confidential delegation admin routes', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    service.listConfidentialDelegationMappings.mockResolvedValue([row]);
    service.createConfidentialDelegationMapping.mockResolvedValue(row);
    service.updateConfidentialDelegationMapping.mockResolvedValue({
      ...row,
      enabled: false,
    });
    service.deleteConfidentialDelegationMapping.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalSharedSecret === undefined) {
      Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    } else {
      process.env.SHARED_SECRET = originalSharedSecret;
    }
    if (originalDatabaseUrl === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_URL');
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('requires the superuser guard on the collection', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/confidential-delegations',
      });
      expect(response.statusCode).toBe(401);
      expect(service.listConfidentialDelegationMappings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('lists only serialized policy metadata', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/confidential-delegations',
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          id: 'delegation-1',
          source_domain: 'api.nessie.works',
          product: 'nessie',
          scopes: ['ai.invoke'],
        }),
      ]);
      expect(JSON.stringify(response.json())).not.toMatch(/client_secret|client_hash|digest/i);
    } finally {
      await app.close();
    }
  });

  it('creates, updates, and deletes mappings with the authenticated actor', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    const headers = { authorization: 'Bearer admin-token' };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/internal/admin/confidential-delegations',
        headers,
        payload: {
          source_domain: 'api.nessie.works',
          product: 'nessie',
          resource: 'https://ledger.unlikeotherai.com',
          scopes: ['ai.invoke'],
        },
      });
      const updated = await app.inject({
        method: 'PATCH',
        url: '/internal/admin/confidential-delegations/delegation-1',
        headers,
        payload: { enabled: false },
      });
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/internal/admin/confidential-delegations/delegation-1',
        headers,
      });

      expect(created.statusCode).toBe(201);
      expect(updated.statusCode).toBe(200);
      expect(deleted.statusCode).toBe(204);
      const actor = { userId: 'admin-1', email: 'admin@example.com' };
      expect(service.createConfidentialDelegationMapping).toHaveBeenCalledWith(
        expect.objectContaining({ actor }),
      );
      expect(service.updateConfidentialDelegationMapping).toHaveBeenCalledWith(
        expect.objectContaining({ mappingId: 'delegation-1', actor }),
      );
      expect(service.deleteConfidentialDelegationMapping).toHaveBeenCalledWith({
        mappingId: 'delegation-1',
        actor,
      });
    } finally {
      await app.close();
    }
  });
});
