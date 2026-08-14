import { ConfidentialDelegationScope, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  createConfidentialDelegationMapping,
  deleteConfidentialDelegationMapping,
  resolveConfidentialDelegation,
  resolveConfidentialDelegationForSource,
  serializeConfidentialDelegationMapping,
  updateConfidentialDelegationMapping,
} from '../../src/services/confidential-delegation.service.js';

// Use a non-pinned product/domain for the generic fixtures: nessie on
// api.nessie.works is server-pinned and rejects any other resource/scope set.
const sourceDomain = 'api.deepsignal.live';
const clientDomainId = 'client-domain-deepsignal';
const product = 'deepsignal';
const resource = 'https://ledger.unlikeotherai.com/v1/mcp/deepwater';
const now = new Date('2026-07-19T10:00:00.000Z');

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delegation-1',
    clientDomainId,
    product,
    resource,
    scopes: [ConfidentialDelegationScope.AI_INVOKE, ConfidentialDelegationScope.BILLING_READ],
    enabled: true,
    createdByUserId: 'admin-1',
    createdByEmail: 'admin@example.com',
    updatedByUserId: 'admin-1',
    updatedByEmail: 'admin@example.com',
    createdAt: now,
    updatedAt: now,
    clientDomain: { domain: sourceDomain, status: 'active' },
    ...overrides,
  };
}

function resolverPrisma(row = mapping() as ReturnType<typeof mapping> | null) {
  const findUnique = vi.fn(
    async ({
      where,
    }: {
      where: {
        clientDomainId_product: {
          clientDomainId: string;
          product: string;
        };
      };
    }) => {
      const key = where.clientDomainId_product;
      if (row && key.clientDomainId === row.clientDomainId && key.product === row.product) {
        return row;
      }
      return null;
    },
  );
  return {
    prisma: {
      clientDomain: {
        findUnique: vi.fn().mockResolvedValue({
          id: clientDomainId,
          status: 'active',
        }),
      },
      confidentialDelegationMapping: { findUnique },
    } as unknown as PrismaClient,
    findUnique,
  };
}

function request(overrides: Record<string, string> = {}) {
  return {
    authenticatedClientDomainId: clientDomainId,
    sourceDomain,
    product,
    resource,
    scope: 'ai.invoke',
    ...overrides,
  };
}

describe('confidential delegation resolution', () => {
  it('returns exactly the requested allowlisted scopes without widening', async () => {
    const { prisma } = resolverPrisma();

    await expect(
      resolveConfidentialDelegation(request({ scope: 'billing.read ai.invoke' }), { prisma }),
    ).resolves.toEqual({
      product,
      resource,
      scope: 'ai.invoke billing.read',
    });

    await expect(
      resolveConfidentialDelegation(request({ scope: 'billing.read' }), {
        prisma,
      }),
    ).resolves.toEqual({
      product,
      resource,
      scope: 'billing.read',
    });
  });

  it('allows token provisioning only when the exact app/product mapping grants it', async () => {
    const { prisma } = resolverPrisma(
      mapping({ scopes: [ConfidentialDelegationScope.TOKEN_PROVISION] }),
    );

    await expect(
      resolveConfidentialDelegation(request({ scope: 'token.provision' }), { prisma }),
    ).resolves.toEqual({
      product,
      resource,
      scope: 'token.provision',
    });
    await expect(
      resolveConfidentialDelegation(request({ scope: 'ai.invoke' }), { prisma }),
    ).rejects.toThrow('TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED');
  });

  it('re-resolves the original active source domain before validating a chained hop', async () => {
    const { prisma } = resolverPrisma();

    await expect(
      resolveConfidentialDelegationForSource(
        {
          sourceDomain,
          product,
          resource,
          scope: 'ai.invoke',
        },
        { prisma },
      ),
    ).resolves.toEqual({
      product,
      resource,
      scope: 'ai.invoke',
    });
    expect(prisma.clientDomain.findUnique).toHaveBeenCalledWith({
      where: { domain: sourceDomain },
      select: { id: true, status: true },
    });
  });

  it.each([
    ['another app credential', { authenticatedClientDomainId: 'client-domain-deepwater' }],
    ['another product', { product: 'deepwater' }],
    ['a non-canonical product', { product: 'DeepSignal' }],
    ['another source domain', { sourceDomain: 'api.deepwater.works' }],
    ['another resource', { resource: `${resource}/other` }],
    ['an unsupported scope', { scope: 'admin' }],
    ['token provisioning without a grant', { scope: 'token.provision' }],
    ['duplicate scopes', { scope: 'ai.invoke ai.invoke' }],
    ['scope widening', { scope: 'ai.invoke billing.read' }],
  ])('rejects %s against a single-scope mapping', async (_label, overrides) => {
    const { prisma } = resolverPrisma(mapping({ scopes: [ConfidentialDelegationScope.AI_INVOKE] }));

    await expect(
      resolveConfidentialDelegation(request(overrides), { prisma }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED',
    });
  });

  it.each([
    ['unknown', null],
    ['disabled', mapping({ enabled: false })],
    [
      'attached to a disabled domain',
      mapping({ clientDomain: { domain: sourceDomain, status: 'disabled' } }),
    ],
  ])('fails closed for a %s mapping', async (_label, row) => {
    const { prisma } = resolverPrisma(row);
    await expect(resolveConfidentialDelegation(request(), { prisma })).rejects.toThrow(
      'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED',
    );
  });
});

function mutationPrisma() {
  const created = mapping();
  const updated = mapping({
    resource: 'https://ledger.unlikeotherai.com/v2',
    enabled: false,
  });
  const tx = {
    clientDomain: {
      findUnique: vi.fn().mockResolvedValue({
        id: clientDomainId,
        status: 'active',
      }),
    },
    confidentialDelegationMapping: {
      create: vi.fn().mockResolvedValue(created),
      findUnique: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockResolvedValue(updated),
      delete: vi.fn().mockResolvedValue(created),
    },
    adminAuditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx, created, updated };
}

describe('confidential delegation admin mutations', () => {
  const actor = { userId: 'admin-1', email: 'admin@example.com' };

  it('creates a normalized mapping and an audit event without credential material', async () => {
    const { prisma, tx, created } = mutationPrisma();
    const result = await createConfidentialDelegationMapping(
      {
        sourceDomain: 'API.DEEPSIGNAL.LIVE',
        product: 'DeepSignal',
        resource,
        scopes: ['billing.read', 'ai.invoke'],
        actor,
      },
      { prisma },
    );

    expect(result).toBe(created);
    expect(tx.confidentialDelegationMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientDomainId,
          product: 'deepsignal',
          resource,
          scopes: [ConfidentialDelegationScope.AI_INVOKE, ConfidentialDelegationScope.BILLING_READ],
        }),
      }),
    );
    const auditData = tx.adminAuditLog.create.mock.calls[0]?.[0].data;
    expect(auditData.action).toBe('confidential_delegation.created');
    expect(JSON.stringify(auditData)).not.toMatch(/client_secret|client_hash|credential|digest/i);
  });

  it('updates only mutable policy fields and audits before/after state', async () => {
    const { prisma, tx, updated } = mutationPrisma();
    await expect(
      updateConfidentialDelegationMapping(
        {
          mappingId: 'delegation-1',
          resource: updated.resource,
          enabled: false,
          actor,
        },
        { prisma },
      ),
    ).resolves.toBe(updated);

    expect(tx.confidentialDelegationMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delegation-1' },
        data: expect.not.objectContaining({
          clientDomainId: expect.anything(),
          product: expect.anything(),
        }),
      }),
    );
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'confidential_delegation.updated',
          metadata: expect.objectContaining({
            before: expect.any(Object),
            after: expect.any(Object),
          }),
        }),
      }),
    );
  });

  it('deletes an exact mapping and leaves a durable audit record', async () => {
    const { prisma, tx } = mutationPrisma();
    await deleteConfidentialDelegationMapping({ mappingId: 'delegation-1', actor }, { prisma });

    expect(tx.confidentialDelegationMapping.delete).toHaveBeenCalledWith({
      where: { id: 'delegation-1' },
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'confidential_delegation.deleted',
        }),
      }),
    );
  });

  it('accepts the exact server-pinned Nessie identity/membership mapping', async () => {
    const pinned = mapping({
      product: 'nessie',
      clientDomain: { domain: 'api.nessie.works', status: 'active' },
      resource: 'https://authentication.unlikeotherai.com',
      scopes: [
        ConfidentialDelegationScope.IDENTITY_READ,
        ConfidentialDelegationScope.MEMBERSHIP_INVITE,
        ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
      ],
    });
    const { prisma, tx } = mutationPrisma();
    tx.confidentialDelegationMapping.create.mockResolvedValue(pinned);

    await expect(
      createConfidentialDelegationMapping(
        {
          sourceDomain: 'api.nessie.works',
          product: 'nessie',
          resource: 'https://authentication.unlikeotherai.com',
          scopes: ['identity.read', 'membership.invite', 'membership.manage'],
          actor,
        },
        { prisma },
      ),
    ).resolves.toBe(pinned);
    expect(tx.confidentialDelegationMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          product: 'nessie',
          resource: 'https://authentication.unlikeotherai.com',
          scopes: [
            ConfidentialDelegationScope.IDENTITY_READ,
            ConfidentialDelegationScope.MEMBERSHIP_INVITE,
            ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
          ],
        }),
      }),
    );
  });

  it.each([
    {
      name: 'a widened scope allowlist',
      scopes: ['identity.read', 'membership.invite', 'membership.manage', 'ai.invoke'],
      resource: 'https://authentication.unlikeotherai.com',
    },
    {
      name: 'a narrowed scope allowlist',
      scopes: ['identity.read'],
      resource: 'https://authentication.unlikeotherai.com',
    },
    {
      name: 'a different resource',
      scopes: ['identity.read', 'membership.invite', 'membership.manage'],
      resource: 'https://ledger.unlikeotherai.com',
    },
    {
      name: 'a different source domain',
      scopes: ['identity.read', 'membership.invite', 'membership.manage'],
      resource: 'https://authentication.unlikeotherai.com',
      sourceDomain: 'api.deepwater.live',
    },
  ])('refuses to create the Nessie pin with $name', async (input) => {
    const { prisma, tx } = mutationPrisma();
    await expect(
      createConfidentialDelegationMapping(
        {
          sourceDomain: input.sourceDomain ?? 'api.nessie.works',
          product: 'nessie',
          resource: input.resource,
          scopes: input.scopes,
          actor,
        },
        { prisma },
      ),
    ).rejects.toThrow('FIRST_PARTY_CONFIDENTIAL_DELEGATION_MISMATCH');
    expect(tx.confidentialDelegationMapping.create).not.toHaveBeenCalled();
  });

  it('refuses to widen an existing Nessie mapping beyond the pin', async () => {
    const pinned = mapping({
      product: 'nessie',
      clientDomain: { domain: 'api.nessie.works', status: 'active' },
      resource: 'https://authentication.unlikeotherai.com',
      scopes: [
        ConfidentialDelegationScope.IDENTITY_READ,
        ConfidentialDelegationScope.MEMBERSHIP_INVITE,
        ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
      ],
    });
    const { prisma, tx } = mutationPrisma();
    tx.confidentialDelegationMapping.findUnique.mockResolvedValue(pinned);

    await expect(
      updateConfidentialDelegationMapping(
        {
          mappingId: 'delegation-1',
          scopes: ['identity.read', 'membership.invite', 'membership.manage', 'billing.read'],
          actor,
        },
        { prisma },
      ),
    ).rejects.toThrow('FIRST_PARTY_CONFIDENTIAL_DELEGATION_MISMATCH');
    expect(tx.confidentialDelegationMapping.update).not.toHaveBeenCalled();

    await expect(
      updateConfidentialDelegationMapping(
        {
          mappingId: 'delegation-1',
          resource: 'https://ledger.unlikeotherai.com',
          actor,
        },
        { prisma },
      ),
    ).rejects.toThrow('FIRST_PARTY_CONFIDENTIAL_DELEGATION_MISMATCH');
    expect(tx.confidentialDelegationMapping.update).not.toHaveBeenCalled();
  });

  it('still allows disabling the pinned Nessie mapping', async () => {
    const pinned = mapping({
      product: 'nessie',
      clientDomain: { domain: 'api.nessie.works', status: 'active' },
      resource: 'https://authentication.unlikeotherai.com',
      scopes: [
        ConfidentialDelegationScope.IDENTITY_READ,
        ConfidentialDelegationScope.MEMBERSHIP_INVITE,
        ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
      ],
    });
    const { prisma, tx } = mutationPrisma();
    tx.confidentialDelegationMapping.findUnique.mockResolvedValue(pinned);
    tx.confidentialDelegationMapping.update.mockResolvedValue({ ...pinned, enabled: false });

    await expect(
      updateConfidentialDelegationMapping(
        { mappingId: 'delegation-1', enabled: false, actor },
        { prisma },
      ),
    ).resolves.toMatchObject({ enabled: false });
    expect(tx.confidentialDelegationMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
    );
  });

  it('serializes policy metadata without internal domain or credential ids', () => {
    const serialized = serializeConfidentialDelegationMapping(mapping());
    expect(serialized).toMatchObject({
      source_domain: sourceDomain,
      product,
      resource,
      scopes: ['ai.invoke', 'billing.read'],
    });
    expect(serialized).not.toHaveProperty('client_domain_id');
    expect(serialized).not.toHaveProperty('credential_id');
  });
});
