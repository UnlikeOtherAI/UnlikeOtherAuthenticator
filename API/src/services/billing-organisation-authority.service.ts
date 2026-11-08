import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import { verifyBillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';

export type OrganisationBillingContext = {
  request: { product: string; organisationId: string; teamId: string | null; userId: string };
  credential: VerifiedBillingAppKey; actorToken: string; endpoint: BillingActorEndpoint;
};

/** No tariff, provider, wallet or metering read is needed to answer admission. */
export async function authorizeOrganisationBilling(context: OrganisationBillingContext,
  prisma: PrismaClient = getAdminPrisma()) {
  if (context.credential.service.identifier !== context.request.product) {
    throw new AppError('FORBIDDEN',403,'BILLING_PRODUCT_MISMATCH');
  }
  const actor=await verifyBillingActor({ token: context.actorToken, credential: context.credential,
    endpoint: context.endpoint, request: context.request }, { prisma });
  const current=await prisma.user.findFirst({where:{id:actor.sub,lifecycleStatus:'ACTIVE',tokenVersion:actor.tv},select:{id:true}});
  if(!current)throw new AppError('FORBIDDEN',403,'BILLING_SUBJECT_NOT_ENTITLED');
  return resolveBillingFundingViewer(context.request, { prisma });
}
