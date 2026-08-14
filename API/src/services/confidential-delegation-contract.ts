import { ConfidentialDelegationScope, type Prisma } from '@prisma/client';

import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

/**
 * Confidential-delegation contract: the one module that owns the delegation
 * scope literal names and their database enum mapping, the server-owned
 * first-party pins, and every normalization/policy rule shared by the
 * resolver and the admin CRUD surface. Both depend one-way on this module,
 * so no resolver/admin/binding cycle can exist.
 *
 * `confidential-delegation.service.ts` re-exports the compatibility API from
 * here; it owns nothing itself beyond resolution.
 */
export const CONFIDENTIAL_DELEGATION_SCOPES = [
  'ai.invoke',
  'billing.read',
  'token.provision',
  'identity.read',
  'membership.invite',
  'membership.manage',
] as const;
export type ConfidentialDelegationScopeName = (typeof CONFIDENTIAL_DELEGATION_SCOPES)[number];

/** Privileged identity/membership delegation scopes. Unlike every other
 *  delegation scope, these are globally exclusive: only the distinct
 *  first-party product key `nessie-identity` on the exact pinned source may
 *  ever hold them, in either direction (creation, update, or runtime
 *  resolve). Product `nessie` is deliberately not the privileged owner so a
 *  broad Nessie mapping can never silently inherit them. */
export const PRIVILEGED_IDENTITY_MEMBERSHIP_SCOPES = [
  'identity.read',
  'membership.invite',
  'membership.manage',
] as const satisfies readonly ConfidentialDelegationScopeName[];

/** The exact server-owned pin for the sole privileged mapping. */
export const PRIVILEGED_IDENTITY_MEMBERSHIP_PIN = {
  sourceDomain: 'api.nessie.works',
  // The literal product key is quoted exactly; the DB stores the same value
  // under the product column of the existing unique(clientDomainId, product)
  // mapping key.
  product: 'nessie-identity',
  resource: 'https://authentication.unlikeotherai.com',
  scopes: PRIVILEGED_IDENTITY_MEMBERSHIP_SCOPES,
} as const;

const databaseScope = {
  'ai.invoke': ConfidentialDelegationScope.AI_INVOKE,
  'billing.read': ConfidentialDelegationScope.BILLING_READ,
  'token.provision': ConfidentialDelegationScope.TOKEN_PROVISION,
  'identity.read': ConfidentialDelegationScope.IDENTITY_READ,
  'membership.invite': ConfidentialDelegationScope.MEMBERSHIP_INVITE,
  'membership.manage': ConfidentialDelegationScope.MEMBERSHIP_MANAGE,
} satisfies Record<ConfidentialDelegationScopeName, ConfidentialDelegationScope>;

const publicScope = {
  [ConfidentialDelegationScope.AI_INVOKE]: 'ai.invoke',
  [ConfidentialDelegationScope.BILLING_READ]: 'billing.read',
  [ConfidentialDelegationScope.TOKEN_PROVISION]: 'token.provision',
  [ConfidentialDelegationScope.IDENTITY_READ]: 'identity.read',
  [ConfidentialDelegationScope.MEMBERSHIP_INVITE]: 'membership.invite',
  [ConfidentialDelegationScope.MEMBERSHIP_MANAGE]: 'membership.manage',
} satisfies Record<ConfidentialDelegationScope, ConfidentialDelegationScopeName>;

const PRIVILEGED_DATABASE_SCOPES = PRIVILEGED_IDENTITY_MEMBERSHIP_SCOPES.map(
  (scope) => databaseScope[scope],
);
const PRIVILEGED_SCOPE_SET = new Set<string>(PRIVILEGED_IDENTITY_MEMBERSHIP_SCOPES);
const PRIVILEGED_DATABASE_SCOPE_SET = new Set<ConfidentialDelegationScope>(
  PRIVILEGED_DATABASE_SCOPES,
);

// Product configuration is still operator-owned, but first-party products
// that cross a privileged boundary have a server-owned immutable destination.
// A DocGen config JWT can never widen this to another Ledger origin or scope.
export const FIRST_PARTY_CONFIDENTIAL_DELEGATIONS = {
  docgen: {
    sourceDomain: 'buildme.live',
    resource: 'https://ledger.unlikeotherai.com',
    scopes: ['ai.invoke'],
  },
  // Phase A1: Nessie's identity/membership delegation is server-owned. The
  // product key matches the literal product string `nessie-identity` exactly
  // (quoted key, never an identifier with the underscore spelling).
  'nessie-identity': {
    sourceDomain: PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.sourceDomain,
    resource: PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.resource,
    scopes: PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.scopes,
  },
} as const;

export type MutationActor = {
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

export const confidentialDelegationMappingInclude = {
  clientDomain: {
    select: {
      domain: true,
      status: true,
    },
  },
} satisfies Prisma.ConfidentialDelegationMappingInclude;

export function normalizeConfidentialDelegationProduct(value: string): string {
  const product = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(product)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_CONFIDENTIAL_DELEGATION_PRODUCT');
  }
  return product;
}

export function normalizeConfidentialDelegationResource(value: string): string {
  const resource = value.trim();
  if (!resource || resource.length > 2048) {
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

export function normalizeConfidentialDelegationScopeNames(
  scopes: readonly string[],
): ConfidentialDelegationScopeName[] {
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

export function databaseScopesFromNames(
  scopes: readonly ConfidentialDelegationScopeName[],
): ConfidentialDelegationScope[] {
  return scopes.map((scope) => databaseScope[scope]);
}

export function scopeNamesFromDatabase(
  scopes: readonly ConfidentialDelegationScope[],
): ConfidentialDelegationScopeName[] {
  return scopes.map((scope) => publicScope[scope]);
}

function privilegedScopeNames(
  scopes: readonly ConfidentialDelegationScopeName[],
): ConfidentialDelegationScopeName[] {
  return scopes.filter((scope) => PRIVILEGED_SCOPE_SET.has(scope));
}

function privilegedDatabaseScopes(
  scopes: readonly ConfidentialDelegationScope[],
): ConfidentialDelegationScope[] {
  return scopes.filter((scope) => PRIVILEGED_DATABASE_SCOPE_SET.has(scope));
}

function rejectPrivileged(): never {
  throw new AppError('BAD_REQUEST', 400, 'PRIVILEGED_CONFIDENTIAL_DELEGATION_SCOPE_FORBIDDEN');
}

/** Enforce the privileged-scope exclusivity contract on create/update.
 *  Non-owner products carrying any privileged scope are rejected; the
 *  `nessie-identity` owner must match the pin exactly (source, resource, and
 *  exact ordered scope set). Bindings without privileged scopes are ignored
 *  unless they claim the owner product: any `nessie-identity` binding is
 *  always held to the pin, so a mapping that drifted to zero privileged
 *  values can never be written or kept under the owner key. */
export function assertPrivilegedDelegationPolicy(params: {
  sourceDomain: string;
  product: string;
  resource: string;
  scopes: readonly ConfidentialDelegationScope[];
}): void {
  if (
    params.product !== PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.product &&
    privilegedDatabaseScopes(params.scopes).length === 0
  ) {
    return;
  }
  if (
    params.product !== PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.product ||
    params.sourceDomain !== PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.sourceDomain ||
    params.resource !== PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.resource ||
    params.scopes.length !== PRIVILEGED_DATABASE_SCOPES.length ||
    params.scopes.some((scope, index) => scope !== PRIVILEGED_DATABASE_SCOPES[index])
  ) {
    rejectPrivileged();
  }
}

/** Enforce the same contract on runtime resolve, where the requester presents
 *  string scope names and the stored mapping presents enum values. The guard
 *  triggers whenever the product is `nessie-identity` or either the stored or
 *  the requested side carries any privileged scope, so a drifted owner
 *  mapping (even one narrowed to [ai.invoke]) fails closed before any token
 *  is issued. */
export function assertPrivilegedRuntimeBinding(params: {
  sourceDomain: string;
  product: string;
  resource: string;
  mappingScopes: readonly ConfidentialDelegationScope[];
  requestedScopes: readonly ConfidentialDelegationScopeName[];
}): void {
  if (
    params.product !== PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.product &&
    privilegedScopeNames(params.requestedScopes).length === 0 &&
    privilegedDatabaseScopes(params.mappingScopes).length === 0
  ) {
    return;
  }
  if (
    params.product !== PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.product ||
    params.sourceDomain !== PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.sourceDomain ||
    params.resource !== PRIVILEGED_IDENTITY_MEMBERSHIP_PIN.resource
  ) {
    rejectPrivileged();
  }
  assertPrivilegedDelegationPolicy({
    sourceDomain: params.sourceDomain,
    product: params.product,
    resource: params.resource,
    scopes: params.mappingScopes,
  });
}

/** Server-owned first-party destinations are immutable at the DB surface: a
 *  mapping for one of these products must match its pin exactly. */
export function assertFirstPartyDelegationBinding(params: {
  sourceDomain: string;
  product: string;
  resource: string;
  scopes: readonly ConfidentialDelegationScope[];
}): void {
  const binding =
    FIRST_PARTY_CONFIDENTIAL_DELEGATIONS[
      params.product as keyof typeof FIRST_PARTY_CONFIDENTIAL_DELEGATIONS
    ];
  if (!binding) return;
  const scopes = scopeNamesFromDatabase(params.scopes);
  if (
    params.sourceDomain !== binding.sourceDomain ||
    params.resource !== binding.resource ||
    scopes.length !== binding.scopes.length ||
    scopes.some((scope, index) => scope !== binding.scopes[index])
  ) {
    throw new AppError('BAD_REQUEST', 400, 'FIRST_PARTY_CONFIDENTIAL_DELEGATION_MISMATCH');
  }
}

export function normalizeDelegationSourceDomain(value: string): string {
  return normalizeDomain(value);
}
