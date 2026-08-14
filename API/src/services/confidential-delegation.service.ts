import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import {
  assertPrivilegedRuntimeBinding,
  confidentialDelegationMappingInclude,
  normalizeConfidentialDelegationProduct,
  normalizeConfidentialDelegationScopeNames,
  scopeNamesFromDatabase,
  type ConfidentialDelegationScopeName,
} from './confidential-delegation-contract.js';

// The delegation contract (scope literals/types, enum maps, first-party pins,
// and privileged-scope policy) lives in confidential-delegation-contract.ts;
// this resolver and the admin module both depend one-way on it. Everything
// below is re-exported so existing route/test imports keep their established
// entry point.
export {
  assertFirstPartyDelegationBinding,
  assertPrivilegedDelegationPolicy,
  assertPrivilegedRuntimeBinding,
  CONFIDENTIAL_DELEGATION_SCOPES,
  FIRST_PARTY_CONFIDENTIAL_DELEGATIONS,
  PRIVILEGED_IDENTITY_MEMBERSHIP_PIN,
  PRIVILEGED_IDENTITY_MEMBERSHIP_SCOPES,
  confidentialDelegationMappingInclude,
  databaseScopesFromNames,
  normalizeConfidentialDelegationProduct,
  normalizeConfidentialDelegationResource,
  normalizeConfidentialDelegationScopeNames,
  scopeNamesFromDatabase,
  type ConfidentialDelegationMappingView,
  type ConfidentialDelegationScopeName,
  type MutationActor,
} from './confidential-delegation-contract.js';
export {
  createConfidentialDelegationMapping,
  deleteConfidentialDelegationMapping,
  listConfidentialDelegationMappings,
  serializeConfidentialDelegationMapping,
  updateConfidentialDelegationMapping,
} from './confidential-delegation-admin.service.js';

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

export function parseConfidentialDelegationScope(scope: string): ConfidentialDelegationScopeName[] {
  const requested = scope.trim().split(/\s+/);
  try {
    return normalizeConfidentialDelegationScopeNames(requested);
  } catch {
    throw invalidDelegation();
  }
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
    product = normalizeConfidentialDelegationProduct(params.product);
    requestedScopes = parseConfidentialDelegationScope(params.scope);
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
    include: confidentialDelegationMappingInclude,
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

  // Privileged identity/membership scopes are globally exclusive to the
  // `nessie-identity` binding: the request, and the stored mapping itself,
  // must both match the server-owned pin exactly. The guard triggers whenever
  // the product is `nessie-identity` or either side carries a privileged
  // scope, so a mapping that drifted since creation (even to a bare
  // [ai.invoke]) fails closed here before any token is issued.
  try {
    assertPrivilegedRuntimeBinding({
      sourceDomain: mapping.clientDomain.domain,
      product: mapping.product,
      resource: mapping.resource,
      mappingScopes: mapping.scopes,
      requestedScopes,
    });
  } catch {
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

export async function resolveConfidentialDelegationForSource(
  params: {
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
  const sourceDomain = normalizeDomain(params.sourceDomain);
  if (!sourceDomain) throw invalidDelegation();

  const source = await client(deps).clientDomain.findUnique({
    where: { domain: sourceDomain },
    select: { id: true, status: true },
  });
  if (!source || source.status !== 'active') throw invalidDelegation();

  return resolveConfidentialDelegation(
    {
      authenticatedClientDomainId: source.id,
      sourceDomain,
      product: params.product,
      resource: params.resource,
      scope: params.scope,
    },
    deps,
  );
}
