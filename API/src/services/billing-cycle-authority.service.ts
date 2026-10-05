import { BillingAssignmentScope, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import { verifyBillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import type { BillingFundingViewer } from './billing-funding-viewer.service.js';
import { isBillingManager } from './billing-stripe-manager.service.js';

export type BillingCycleSubject = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

export async function authorizeBillingCycle(
  params: {
    credential: VerifiedBillingAppKey;
    actorToken: string;
    endpoint: BillingActorEndpoint;
    request: BillingCycleSubject;
    payerScope?: BillingAssignmentScope;
  },
  deps?: { prisma?: PrismaClient },
): Promise<BillingFundingViewer> {
  if (params.credential.service.identifier !== params.request.product) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_CYCLE_PRODUCT_MISMATCH');
  }
  await verifyBillingActor({
    token: params.actorToken,
    credential: params.credential,
    endpoint: params.endpoint,
    request: params.request,
  });
  const viewer = await resolveBillingFundingViewer({
    userId: params.request.userId,
    organisationId: params.request.organisationId,
    teamId: params.request.teamId,
  }, { prisma: deps?.prisma ?? getAdminPrisma() });
  if (!isBillingManager({
    scope: params.payerScope ?? BillingAssignmentScope.TEAM,
    orgRole: viewer.organisationRole,
    teamRole: viewer.teamRole,
  })) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_CYCLE_MANAGER_REQUIRED');
  }
  return viewer;
}
