import { BillingAppKeyPurpose, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';

export type ProductWorkspacePolicy =
  | { scope: 'client_domain' }
  | {
      scope: 'all_active_memberships';
      serviceId: string;
      product: string;
    };

export const CLIENT_DOMAIN_WORKSPACE_POLICY: ProductWorkspacePolicy = {
  scope: 'client_domain',
};

export type ProductWorkspacePolicyPrisma = Pick<PrismaClient, 'billingAppKey' | 'clientDomain'>;

/**
 * Resolve the server-owned policy that connects one verified SSO config domain
 * to one UOA billing product. The signed client config cannot opt itself in.
 *
 * A product domain is eligible only when it is an active ClientDomain and an
 * exact HTTPS actor issuer for at least one current CUSTOMER_LIFECYCLE key. All
 * matching keys must belong to the same active BillingService; unknown,
 * inactive, expired, revoked, or ambiguous mappings retain legacy same-domain
 * isolation. Reusing this already-administered credential binding avoids a
 * circular dependency on direct-access evidence, which is written only after
 * the first successful product login.
 */
export async function resolveProductWorkspacePolicy(
  params: { domain: string },
  deps?: {
    now?: () => Date;
    prisma?: ProductWorkspacePolicyPrisma;
  },
): Promise<ProductWorkspacePolicy> {
  const domain = normalizeDomain(params.domain);
  if (!domain) return CLIENT_DOMAIN_WORKSPACE_POLICY;

  const prisma = deps?.prisma ?? (getAdminPrisma() as ProductWorkspacePolicyPrisma);
  const clientDomain = await prisma.clientDomain.findUnique({
    where: { domain },
    select: { status: true },
  });
  if (clientDomain?.status !== 'active') return CLIENT_DOMAIN_WORKSPACE_POLICY;

  const now = deps?.now?.() ?? new Date();
  const appKeys = await prisma.billingAppKey.findMany({
    where: {
      actorIssuer: `https://${domain}`,
      purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      service: { active: true },
    },
    select: {
      serviceId: true,
      service: { select: { identifier: true } },
    },
  });

  const services = new Map(appKeys.map((row) => [row.serviceId, row.service.identifier] as const));
  if (services.size !== 1) return CLIENT_DOMAIN_WORKSPACE_POLICY;

  const service = services.entries().next().value;
  if (!service) return CLIENT_DOMAIN_WORKSPACE_POLICY;
  const [serviceId, product] = service;
  return { scope: 'all_active_memberships', serviceId, product };
}
