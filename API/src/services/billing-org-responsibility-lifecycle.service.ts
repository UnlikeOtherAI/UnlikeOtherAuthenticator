import { type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { authorizeBillingCustomerAction } from './billing-customer-action-intent.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import {
  isOrganisationBillingManager,
  resolveOrgBillingResponsibility,
} from './billing-org-responsibility.service.js';
import { assertOrgBillingAssumable } from './billing-org-responsibility-guard.service.js';
import { billingRegionView, type BillingRegionViewV1 } from './billing-organisation-region.service.js';

export type BillingOrgResponsibilityRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

type Dependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  resolveTariff?: typeof resolveEffectiveTariffContext;
  isOrganisationManager?: typeof isOrganisationBillingManager;
  authorizeAction?: typeof authorizeBillingCustomerAction;
  assertAssumable?: typeof assertOrgBillingAssumable;
};

export type BillingOrgResponsibilityView = {
  organisation_id: string;
  active: boolean;
  assumed_at: string | null;
  released_at: string | null;
  deactivated_team_auto_top_ups: number;
};

async function requireOrganisationBillingManager(
  params: {
    request: BillingOrgResponsibilityRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps: Dependencies & { prisma: PrismaClient },
) {
  // The same entitlement path every other billing action uses: it verifies the
  // fresh RS256 actor assertion, its 45-second TTL, the `tv` epoch against the
  // live user row, and active organisation and team membership.
  const { actor } = await (deps.resolveTariff ?? resolveEffectiveTariffContext)(params, {
    prisma: deps.prisma,
  });
  const manager = await (deps.isOrganisationManager ?? isOrganisationBillingManager)(
    { organisationId: params.request.organisationId, userId: params.request.userId },
    { prisma: deps.prisma },
  );
  if (!manager) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_ORG_MANAGER_REQUIRED');
  }
  return actor;
}

function view(params: {
  organisationId: string;
  active: boolean;
  assumedAt: Date | null;
  releasedAt: Date | null;
  deactivatedTeamAutoTopUps: number;
}): BillingOrgResponsibilityView {
  return {
    organisation_id: params.organisationId,
    active: params.active,
    assumed_at: params.assumedAt?.toISOString() ?? null,
    released_at: params.releasedAt?.toISOString() ?? null,
    deactivated_team_auto_top_ups: params.deactivatedTeamAutoTopUps,
  };
}

export async function assumeOrgBillingResponsibility(
  params: {
    request: BillingOrgResponsibilityRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps?: Dependencies,
): Promise<BillingOrgResponsibilityView> {
  const prisma=deps?.prisma??getAdminPrisma();
  await requireOrganisationBillingManager(params,{...deps,prisma});
  throw new AppError('BAD_REQUEST',409,'BILLING_ORGANISATION_SCOPE_REQUIRED');
}

export async function releaseOrgBillingResponsibility(
  params: {
    request: BillingOrgResponsibilityRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps?: Dependencies,
): Promise<BillingOrgResponsibilityView> {
  const prisma=deps?.prisma??getAdminPrisma();
  await requireOrganisationBillingManager(params,{...deps,prisma});
  throw new AppError('BAD_REQUEST',409,'BILLING_ORGANISATION_SCOPE_REQUIRED');
}

export async function readOrgBillingResponsibility(
  params: {
    request: BillingOrgResponsibilityRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps?: Dependencies,
): Promise<BillingOrgResponsibilityView & { can_manage: boolean; billing_region: BillingRegionViewV1 }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  await (deps?.resolveTariff ?? resolveEffectiveTariffContext)(params, { prisma });
  await requireOrganisationBillingManager(params,{...deps,prisma});
  const [state, canManage, record] = await Promise.all([
    resolveOrgBillingResponsibility({ organisationId: params.request.organisationId }, { prisma }),
    (deps?.isOrganisationManager ?? isOrganisationBillingManager)(
      { organisationId: params.request.organisationId, userId: params.request.userId },
      { prisma },
    ),
    prisma.billingOrgResponsibility.findUnique({
      where: { orgId: params.request.organisationId },
      select: { assumedAt: true, releasedAt: true },
    }),
  ]);
  return {
    ...view({
      organisationId: params.request.organisationId,
      active: state.active,
      assumedAt: record?.assumedAt ?? null,
      releasedAt: state.active ? null : (record?.releasedAt ?? null),
      deactivatedTeamAutoTopUps: 0,
    }),
    can_manage: canManage,
    billing_region: await billingRegionView(params.request.organisationId, canManage, prisma),
  };
}
