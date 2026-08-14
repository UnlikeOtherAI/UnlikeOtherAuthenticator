import { ConfidentialDelegationScope } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  createConfidentialDelegationMapping,
  deleteConfidentialDelegationMapping,
  serializeConfidentialDelegationMapping,
  updateConfidentialDelegationMapping,
} from '../../src/services/confidential-delegation.service.js';
import {
  delegationMapping as mapping,
  delegationMutationPrisma as mutationPrisma,
  delegationProduct as product,
  delegationResource as resource,
  delegationSourceDomain as sourceDomain,
} from './confidential-delegation-fixtures.js';

describe('confidential delegation admin mutations', () => {
  const actor = { userId: 'admin-1', email: 'admin@example.com' };

  function pinnedIdentityMapping(overrides: Record<string, unknown> = {}) {
    return mapping({
      product: 'nessie-identity',
      clientDomain: { domain: 'api.nessie.works', status: 'active' },
      resource: 'https://authentication.unlikeotherai.com',
      scopes: [
        ConfidentialDelegationScope.IDENTITY_READ,
        ConfidentialDelegationScope.MEMBERSHIP_INVITE,
        ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
      ],
      ...overrides,
    });
  }

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
          clientDomainId: 'client-domain-deepsignal',
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

  it('accepts the exact server-pinned nessie-identity identity/membership mapping', async () => {
    const pinned = pinnedIdentityMapping();
    const { prisma, tx } = mutationPrisma();
    tx.confidentialDelegationMapping.create.mockResolvedValue(pinned);

    await expect(
      createConfidentialDelegationMapping(
        {
          sourceDomain: 'api.nessie.works',
          product: 'nessie-identity',
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
          product: 'nessie-identity',
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

  it('accepts the exact pinned nessie-identity scopes in any order', async () => {
    const pinned = pinnedIdentityMapping();
    const { prisma, tx } = mutationPrisma();
    tx.confidentialDelegationMapping.create.mockResolvedValue(pinned);

    await expect(
      createConfidentialDelegationMapping(
        {
          sourceDomain: 'api.nessie.works',
          product: 'nessie-identity',
          resource: 'https://authentication.unlikeotherai.com',
          scopes: ['membership.manage', 'identity.read', 'membership.invite'],
          actor,
        },
        { prisma },
      ),
    ).resolves.toBe(pinned);
  });

  it('creates a coexisting nessie mapping without privileged scopes', async () => {
    const nessieLedger = mapping({
      product: 'nessie',
      clientDomain: { domain: 'api.nessie.works', status: 'active' },
      scopes: [ConfidentialDelegationScope.AI_INVOKE, ConfidentialDelegationScope.BILLING_READ],
    });
    const { prisma, tx } = mutationPrisma();
    tx.confidentialDelegationMapping.create.mockResolvedValue(nessieLedger);

    await expect(
      createConfidentialDelegationMapping(
        {
          sourceDomain: 'api.nessie.works',
          product: 'nessie',
          resource: 'https://ledger.unlikeotherai.com/v1/mcp/deepwater',
          scopes: ['ai.invoke', 'billing.read'],
          actor,
        },
        { prisma },
      ),
    ).resolves.toBe(nessieLedger);
    expect(tx.confidentialDelegationMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ product: 'nessie' }),
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
  ])('refuses to create the nessie-identity pin with $name', async (input) => {
    const { prisma, tx } = mutationPrisma();
    await expect(
      createConfidentialDelegationMapping(
        {
          sourceDomain: input.sourceDomain ?? 'api.nessie.works',
          product: 'nessie-identity',
          resource: input.resource,
          scopes: input.scopes,
          actor,
        },
        { prisma },
      ),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PRIVILEGED_CONFIDENTIAL_DELEGATION_SCOPE_FORBIDDEN',
    });
    expect(tx.confidentialDelegationMapping.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'deepsignal with membership.manage',
      product: 'deepsignal',
      scopes: ['membership.manage'],
    },
    {
      name: 'deepsignal with identity.read added to existing scopes',
      product: 'deepsignal',
      scopes: ['ai.invoke', 'identity.read'],
    },
    {
      name: 'the plain nessie product on the pinned source',
      product: 'nessie',
      sourceDomain: 'api.nessie.works',
      scopes: ['identity.read', 'membership.invite', 'membership.manage'],
      resource: 'https://authentication.unlikeotherai.com',
    },
    {
      name: 'privileged scopes under another source domain and product',
      product: 'deepwater',
      sourceDomain: 'api.deepwater.live',
      scopes: ['identity.read', 'membership.invite', 'membership.manage'],
      resource: 'https://authentication.unlikeotherai.com',
    },
  ])('refuses to create $name', async (input) => {
    const { prisma, tx } = mutationPrisma();
    await expect(
      createConfidentialDelegationMapping(
        {
          sourceDomain: input.sourceDomain ?? sourceDomain,
          product: input.product,
          resource: input.resource ?? resource,
          scopes: input.scopes,
          actor,
        },
        { prisma },
      ),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PRIVILEGED_CONFIDENTIAL_DELEGATION_SCOPE_FORBIDDEN',
    });
    expect(tx.confidentialDelegationMapping.create).not.toHaveBeenCalled();
  });

  it('refuses to grant membership.manage to an existing non-owner mapping', async () => {
    const { prisma, tx } = mutationPrisma();
    await expect(
      updateConfidentialDelegationMapping(
        {
          mappingId: 'delegation-1',
          scopes: ['ai.invoke', 'billing.read', 'membership.manage'],
          actor,
        },
        { prisma },
      ),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PRIVILEGED_CONFIDENTIAL_DELEGATION_SCOPE_FORBIDDEN',
    });
    expect(tx.confidentialDelegationMapping.update).not.toHaveBeenCalled();
  });

  it('refuses to widen, narrow, or rebind an existing nessie-identity mapping', async () => {
    const pinned = pinnedIdentityMapping();
    const { prisma, tx } = mutationPrisma();
    tx.confidentialDelegationMapping.findUnique.mockResolvedValue(pinned);

    for (const patch of [
      { scopes: ['identity.read', 'membership.invite', 'membership.manage', 'billing.read'] },
      { scopes: ['identity.read'] },
      { resource: 'https://ledger.unlikeotherai.com' },
    ]) {
      await expect(
        updateConfidentialDelegationMapping(
          { mappingId: 'delegation-1', ...patch, actor },
          { prisma },
        ),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'PRIVILEGED_CONFIDENTIAL_DELEGATION_SCOPE_FORBIDDEN',
      });
    }
    expect(tx.confidentialDelegationMapping.update).not.toHaveBeenCalled();
  });

  it('still allows disabling the pinned nessie-identity mapping', async () => {
    const pinned = pinnedIdentityMapping();
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
