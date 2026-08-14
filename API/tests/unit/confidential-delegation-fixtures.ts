import { ConfidentialDelegationScope, type PrismaClient } from '@prisma/client';
import { vi } from 'vitest';

// Shared fixtures for the confidential-delegation resolver and admin suites.
// Use a non-pinned product/domain for the generic fixtures: `nessie-identity`
// on api.nessie.works is server-pinned and rejects any other resource/scope
// set, and privileged scopes can never appear on any other product.
export const delegationSourceDomain = 'api.deepsignal.live';
export const delegationClientDomainId = 'client-domain-deepsignal';
export const delegationProduct = 'deepsignal';
export const delegationResource = 'https://ledger.unlikeotherai.com/v1/mcp/deepwater';
export const delegationNow = new Date('2026-07-19T10:00:00.000Z');

export function delegationMapping(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delegation-1',
    clientDomainId: delegationClientDomainId,
    product: delegationProduct,
    resource: delegationResource,
    scopes: [ConfidentialDelegationScope.AI_INVOKE, ConfidentialDelegationScope.BILLING_READ],
    enabled: true,
    createdByUserId: 'admin-1',
    createdByEmail: 'admin@example.com',
    updatedByUserId: 'admin-1',
    updatedByEmail: 'admin@example.com',
    createdAt: delegationNow,
    updatedAt: delegationNow,
    clientDomain: { domain: delegationSourceDomain, status: 'active' },
    ...overrides,
  };
}

export function delegationResolverPrisma(
  row = delegationMapping() as ReturnType<typeof delegationMapping> | null,
) {
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
          id: delegationClientDomainId,
          status: 'active',
        }),
      },
      confidentialDelegationMapping: { findUnique },
    } as unknown as PrismaClient,
    findUnique,
  };
}

export function delegationRequest(overrides: Record<string, string> = {}) {
  return {
    authenticatedClientDomainId: delegationClientDomainId,
    sourceDomain: delegationSourceDomain,
    product: delegationProduct,
    resource: delegationResource,
    scope: 'ai.invoke',
    ...overrides,
  };
}

export function delegationMutationPrisma() {
  const created = delegationMapping();
  const updated = delegationMapping({
    resource: 'https://ledger.unlikeotherai.com/v2',
    enabled: false,
  });
  const tx = {
    clientDomain: {
      findUnique: vi.fn().mockResolvedValue({
        id: delegationClientDomainId,
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
