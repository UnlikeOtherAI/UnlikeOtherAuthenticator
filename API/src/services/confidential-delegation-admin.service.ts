import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import {
  assertFirstPartyDelegationBinding,
  assertPrivilegedDelegationPolicy,
  confidentialDelegationMappingInclude,
  databaseScopesFromNames,
  normalizeConfidentialDelegationProduct,
  normalizeConfidentialDelegationResource,
  normalizeConfidentialDelegationScopeNames,
  scopeNamesFromDatabase,
  type ConfidentialDelegationMappingView,
  type MutationActor,
} from './confidential-delegation-contract.js';

type DelegationMutationPrisma = Pick<
  PrismaClient,
  'clientDomain' | 'confidentialDelegationMapping' | 'adminAuditLog' | '$transaction'
>;

function client(deps?: { prisma?: PrismaClient }): DelegationMutationPrisma {
  return (deps?.prisma ?? getAdminPrisma()) as DelegationMutationPrisma;
}

function actorCreateData(actor: MutationActor) {
  return {
    createdByUserId: actor.userId ?? null,
    createdByEmail: actor.email,
    updatedByUserId: actor.userId ?? null,
    updatedByEmail: actor.email,
  };
}

function actorUpdateData(actor: MutationActor) {
  return {
    updatedByUserId: actor.userId ?? null,
    updatedByEmail: actor.email,
  };
}

function auditMetadata(mapping: ConfidentialDelegationMappingView) {
  return {
    mapping_id: mapping.id,
    source_domain: mapping.clientDomain.domain,
    product: mapping.product,
    resource: mapping.resource,
    scopes: scopeNamesFromDatabase(mapping.scopes),
    enabled: mapping.enabled,
  };
}

export function serializeConfidentialDelegationMapping(mapping: ConfidentialDelegationMappingView) {
  return {
    id: mapping.id,
    source_domain: mapping.clientDomain.domain,
    product: mapping.product,
    resource: mapping.resource,
    scopes: scopeNamesFromDatabase(mapping.scopes),
    enabled: mapping.enabled,
    created_by_email: mapping.createdByEmail,
    updated_by_email: mapping.updatedByEmail,
    created_at: mapping.createdAt.toISOString(),
    updated_at: mapping.updatedAt.toISOString(),
  };
}

export async function listConfidentialDelegationMappings(deps?: {
  prisma?: PrismaClient;
}): Promise<ConfidentialDelegationMappingView[]> {
  return client(deps).confidentialDelegationMapping.findMany({
    orderBy: [{ product: 'asc' }, { clientDomainId: 'asc' }],
    include: confidentialDelegationMappingInclude,
  });
}

export async function createConfidentialDelegationMapping(
  params: {
    sourceDomain: string;
    product: string;
    resource: string;
    scopes: string[];
    enabled?: boolean;
    actor: MutationActor;
  },
  deps?: { prisma?: PrismaClient },
): Promise<ConfidentialDelegationMappingView> {
  const sourceDomain = normalizeDomain(params.sourceDomain);
  const product = normalizeConfidentialDelegationProduct(params.product);
  const resource = normalizeConfidentialDelegationResource(params.resource);
  const scopes = databaseScopesFromNames(
    normalizeConfidentialDelegationScopeNames(params.scopes),
  );
  if (!sourceDomain) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_CONFIDENTIAL_DELEGATION_DOMAIN');
  }
  // Global privileged-scope exclusivity runs before the product-keyed pin so
  // any non-`nessie-identity` mapping carrying identity/membership scopes is
  // refused outright.
  assertPrivilegedDelegationPolicy({ sourceDomain, product, resource, scopes });
  assertFirstPartyDelegationBinding({ sourceDomain, product, resource, scopes });

  try {
    return await client(deps).$transaction(async (tx) => {
      const source = await tx.clientDomain.findUnique({
        where: { domain: sourceDomain },
        select: { id: true, status: true },
      });
      if (!source || source.status !== 'active') {
        throw new AppError('BAD_REQUEST', 400, 'CONFIDENTIAL_DELEGATION_DOMAIN_UNAVAILABLE');
      }
      const created = await tx.confidentialDelegationMapping.create({
        data: {
          clientDomainId: source.id,
          product,
          resource,
          scopes,
          enabled: params.enabled ?? true,
          ...actorCreateData(params.actor),
        },
        include: confidentialDelegationMappingInclude,
      });
      await tx.adminAuditLog.create({
        data: {
          actorEmail: params.actor.email,
          action: 'confidential_delegation.created',
          targetDomain: sourceDomain,
          metadata: auditMetadata(created),
        },
      });
      return created;
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'P2002') {
      throw new AppError('BAD_REQUEST', 400, 'CONFIDENTIAL_DELEGATION_EXISTS');
    }
    throw error;
  }
}

export async function updateConfidentialDelegationMapping(
  params: {
    mappingId: string;
    resource?: string;
    scopes?: string[];
    enabled?: boolean;
    actor: MutationActor;
  },
  deps?: { prisma?: PrismaClient },
): Promise<ConfidentialDelegationMappingView> {
  if (
    params.resource === undefined &&
    params.scopes === undefined &&
    params.enabled === undefined
  ) {
    throw new AppError('BAD_REQUEST', 400, 'CONFIDENTIAL_DELEGATION_UPDATE_EMPTY');
  }
  const requestedScopeNames =
    params.scopes === undefined
      ? undefined
      : normalizeConfidentialDelegationScopeNames(params.scopes);
  const data = {
    ...(params.resource === undefined
      ? {}
      : { resource: normalizeConfidentialDelegationResource(params.resource) }),
    ...(requestedScopeNames === undefined
      ? {}
      : { scopes: databaseScopesFromNames(requestedScopeNames) }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
    ...actorUpdateData(params.actor),
  };

  return client(deps).$transaction(async (tx) => {
    const existing = await tx.confidentialDelegationMapping.findUnique({
      where: { id: params.mappingId },
      include: confidentialDelegationMappingInclude,
    });
    if (!existing) {
      throw new AppError('NOT_FOUND', 404, 'CONFIDENTIAL_DELEGATION_NOT_FOUND');
    }
    // Disabling the exact mapping stays allowed even when the stored scopes
    // no longer satisfy the pin; any other mutation touching privileged
    // scopes must converge on the exact `nessie-identity` binding.
    if (
      params.enabled !== false ||
      requestedScopeNames !== undefined ||
      params.resource !== undefined
    ) {
      assertPrivilegedDelegationPolicy({
        sourceDomain: existing.clientDomain.domain,
        product: existing.product,
        resource: data.resource ?? existing.resource,
        scopes: data.scopes ?? existing.scopes,
      });
    }
    assertFirstPartyDelegationBinding({
      sourceDomain: existing.clientDomain.domain,
      product: existing.product,
      resource: data.resource ?? existing.resource,
      scopes: data.scopes ?? existing.scopes,
    });
    const updated = await tx.confidentialDelegationMapping.update({
      where: { id: existing.id },
      data,
      include: confidentialDelegationMappingInclude,
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'confidential_delegation.updated',
        targetDomain: existing.clientDomain.domain,
        metadata: {
          before: auditMetadata(existing),
          after: auditMetadata(updated),
        },
      },
    });
    return updated;
  });
}

export async function deleteConfidentialDelegationMapping(
  params: {
    mappingId: string;
    actor: MutationActor;
  },
  deps?: { prisma?: PrismaClient },
): Promise<void> {
  await client(deps).$transaction(async (tx) => {
    const existing = await tx.confidentialDelegationMapping.findUnique({
      where: { id: params.mappingId },
      include: confidentialDelegationMappingInclude,
    });
    if (!existing) {
      throw new AppError('NOT_FOUND', 404, 'CONFIDENTIAL_DELEGATION_NOT_FOUND');
    }
    await tx.confidentialDelegationMapping.delete({ where: { id: existing.id } });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'confidential_delegation.deleted',
        targetDomain: existing.clientDomain.domain,
        metadata: auditMetadata(existing),
      },
    });
  });
}
