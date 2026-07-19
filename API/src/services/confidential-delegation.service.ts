import { ConfidentialDelegationScope, type Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

const PRODUCT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MAX_RESOURCE_LENGTH = 2048;

export const CONFIDENTIAL_DELEGATION_SCOPES = [
  'ai.invoke',
  'billing.read',
  'token.provision',
] as const;
export type ConfidentialDelegationScopeName = (typeof CONFIDENTIAL_DELEGATION_SCOPES)[number];

const databaseScope = {
  'ai.invoke': ConfidentialDelegationScope.AI_INVOKE,
  'billing.read': ConfidentialDelegationScope.BILLING_READ,
  'token.provision': ConfidentialDelegationScope.TOKEN_PROVISION,
} satisfies Record<ConfidentialDelegationScopeName, ConfidentialDelegationScope>;

const publicScope = {
  [ConfidentialDelegationScope.AI_INVOKE]: 'ai.invoke',
  [ConfidentialDelegationScope.BILLING_READ]: 'billing.read',
  [ConfidentialDelegationScope.TOKEN_PROVISION]: 'token.provision',
} satisfies Record<ConfidentialDelegationScope, ConfidentialDelegationScopeName>;

type MutationActor = {
  userId?: string | null;
  email: string;
};

export type ConfidentialDelegationMappingView = {
  id: string;
  clientDomainId: string;
  product: string;
  resource: string;
  scopes: ConfidentialDelegationScope[];
  enabled: boolean;
  createdByEmail: string | null;
  updatedByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  clientDomain: {
    domain: string;
    status: string;
  };
};

type DelegationPrisma = Pick<
  PrismaClient,
  'clientDomain' | 'confidentialDelegationMapping' | 'adminAuditLog' | '$transaction'
>;

function client(deps?: { prisma?: PrismaClient }): DelegationPrisma {
  return (deps?.prisma ?? getAdminPrisma()) as DelegationPrisma;
}

function invalidDelegation(): AppError {
  return new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED');
}

function normalizeProduct(value: string): string {
  const product = value.trim().toLowerCase();
  if (!PRODUCT_PATTERN.test(product)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_CONFIDENTIAL_DELEGATION_PRODUCT');
  }
  return product;
}

function normalizeResource(value: string): string {
  const resource = value.trim();
  if (!resource || resource.length > MAX_RESOURCE_LENGTH) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_CONFIDENTIAL_DELEGATION_RESOURCE');
  }

  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_CONFIDENTIAL_DELEGATION_RESOURCE');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_CONFIDENTIAL_DELEGATION_RESOURCE');
  }
  return resource;
}

function normalizeScopeNames(scopes: readonly string[]): ConfidentialDelegationScopeName[] {
  const normalized = scopes.map((scope) => scope.trim());
  const unique = new Set(normalized);
  if (
    normalized.length === 0 ||
    normalized.length > CONFIDENTIAL_DELEGATION_SCOPES.length ||
    unique.size !== normalized.length ||
    normalized.some(
      (scope): boolean =>
        !CONFIDENTIAL_DELEGATION_SCOPES.includes(scope as ConfidentialDelegationScopeName),
    )
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_CONFIDENTIAL_DELEGATION_SCOPES');
  }
  return CONFIDENTIAL_DELEGATION_SCOPES.filter((scope) => unique.has(scope));
}

function requestedScopeNames(scope: string): ConfidentialDelegationScopeName[] {
  const requested = scope.trim().split(/\s+/);
  try {
    return normalizeScopeNames(requested);
  } catch {
    throw invalidDelegation();
  }
}

function scopeNamesFromDatabase(
  scopes: readonly ConfidentialDelegationScope[],
): ConfidentialDelegationScopeName[] {
  return scopes.map((scope) => publicScope[scope]);
}

function scopeValuesForDatabase(scopes: readonly string[]): ConfidentialDelegationScope[] {
  return normalizeScopeNames(scopes).map((scope) => databaseScope[scope]);
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

const mappingInclude = {
  clientDomain: {
    select: {
      domain: true,
      status: true,
    },
  },
} satisfies Prisma.ConfidentialDelegationMappingInclude;

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
    include: mappingInclude,
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
  const product = normalizeProduct(params.product);
  const resource = normalizeResource(params.resource);
  const scopes = scopeValuesForDatabase(params.scopes);
  if (!sourceDomain) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_CONFIDENTIAL_DELEGATION_DOMAIN');
  }

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
        include: mappingInclude,
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
  const data = {
    ...(params.resource === undefined ? {} : { resource: normalizeResource(params.resource) }),
    ...(params.scopes === undefined ? {} : { scopes: scopeValuesForDatabase(params.scopes) }),
    ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
    ...actorUpdateData(params.actor),
  };

  return client(deps).$transaction(async (tx) => {
    const existing = await tx.confidentialDelegationMapping.findUnique({
      where: { id: params.mappingId },
      include: mappingInclude,
    });
    if (!existing) {
      throw new AppError('NOT_FOUND', 404, 'CONFIDENTIAL_DELEGATION_NOT_FOUND');
    }
    const updated = await tx.confidentialDelegationMapping.update({
      where: { id: existing.id },
      data,
      include: mappingInclude,
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
      include: mappingInclude,
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

export async function resolveConfidentialDelegation(
  params: {
    authenticatedClientDomainId: string;
    sourceDomain: string;
    product: string;
    resource: string;
    scope: string;
  },
  deps?: { prisma?: PrismaClient },
): Promise<{
  product: string;
  resource: string;
  scope: string;
}> {
  let product: string;
  let requestedScopes: ConfidentialDelegationScopeName[];
  try {
    product = normalizeProduct(params.product);
    requestedScopes = requestedScopeNames(params.scope);
  } catch {
    throw invalidDelegation();
  }
  if (params.product !== product) {
    throw invalidDelegation();
  }

  const mapping = await client(deps).confidentialDelegationMapping.findUnique({
    where: {
      clientDomainId_product: {
        clientDomainId: params.authenticatedClientDomainId,
        product,
      },
    },
    include: mappingInclude,
  });
  const sourceDomain = normalizeDomain(params.sourceDomain);
  if (
    !mapping ||
    !mapping.enabled ||
    mapping.clientDomain.status !== 'active' ||
    mapping.clientDomain.domain !== sourceDomain ||
    mapping.resource !== params.resource
  ) {
    throw invalidDelegation();
  }

  const allowedScopes = new Set(scopeNamesFromDatabase(mapping.scopes));
  if (requestedScopes.some((scope) => !allowedScopes.has(scope))) {
    throw invalidDelegation();
  }

  return {
    product: mapping.product,
    resource: mapping.resource,
    scope: requestedScopes.join(' '),
  };
}
