import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import type { OrgServicePrisma } from './organisation.service.base.js';

const ORGANISATION_SELECT = {
  id: true,
  domain: true,
  name: true,
  slug: true,
  ownerId: true,
  memberInvites: true,
  iconUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ResolvedOrganisationRow = {
  id: string;
  domain: string;
  name: string;
  slug: string;
  ownerId: string;
  memberInvites?: string;
  iconUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Resolve an organisation by id alone — the resolver for the `/org/organisations/:orgId/**`
 * management surface.
 *
 * One organisation is usable from every UOA-integrated product, so "which product is calling"
 * is NOT an authorization predicate here. The gates that do apply have already run or run
 * straight after:
 *
 *  - `requireOrgRole` matched the caller's access token `domain` against `?domain=` and its
 *    `org.org_id` claim against `:orgId`, so a user token can only ever reach the org it is
 *    currently scoped to;
 *  - the services then re-resolve live ACTIVE membership / capability against the row this
 *    returns, which is the real membership gate;
 *  - backend / domain-hash-only callers never reach a by-id resolve with a foreign org: their
 *    origin-domain scope is enforced once, in `acceptDomainBackendCaller`.
 *
 * `organisations.domain` keeps its meaning — the ORIGIN domain, the product that created the
 * org. It still owns the slug namespace and backend-mode ownership. It just no longer decides who
 * may read or manage the org.
 */
export async function resolveOrganisation(
  prisma: OrgServicePrisma,
  params: { orgId: string },
): Promise<ResolvedOrganisationRow> {
  const orgId = params.orgId.trim();
  if (!orgId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const row = await prisma.organisation.findFirst({
    where: { id: orgId },
    select: ORGANISATION_SELECT,
  });

  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}

/**
 * Resolve an organisation by id AND origin domain.
 *
 * The strict resolver, kept for the surfaces whose boundary really is the origin domain:
 * access requests, which are a domain-bound join flow (their RLS policies are domain-bound
 * too), and anywhere else that must not see an org another product created.
 */
export async function resolveOrganisationByDomain(
  prisma: OrgServicePrisma,
  params: { orgId: string; domain: string },
): Promise<ResolvedOrganisationRow> {
  const orgId = params.orgId.trim();
  const domain = normalizeDomain(params.domain);
  if (!orgId || !domain) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const row = await prisma.organisation.findFirst({
    where: { id: orgId, domain },
    select: ORGANISATION_SELECT,
  });

  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}
