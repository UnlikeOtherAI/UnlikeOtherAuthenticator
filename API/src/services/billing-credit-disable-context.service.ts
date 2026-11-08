import type { Prisma,PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { assertBillingActionContext } from './billing-action-context.service.js';
import { verifyBillingActor } from './billing-actor.service.js';
import { requireBillingManager } from './billing-financial-authority.service.js';
import { ensureOrganisationCreditAccount } from './billing-credit-account.service.js';
import { authorizeBillingCustomerAction,BILLING_CUSTOMER_ACTION } from './billing-customer-action-intent.service.js';
import { resolveTeamBillingMode } from './billing-team-mode.service.js';
import type { resolveCreditFundingActionContext } from './billing-credit-funding-context.service.js';

/** Revoking future charging is a UOA database operation. A failed provider,
 * expired card, missing catalog or FX outage cannot require another payment
 * read before a currently authorised manager can revoke the saved consent. */
export async function resolveCreditDisableContext(params:Parameters<typeof resolveCreditFundingActionContext>[0],
  deps?:{prisma?:PrismaClient}) {
  const prisma=deps?.prisma??getAdminPrisma();
  const actor=await verifyBillingActor({token:params.actorToken,credential:params.credential,endpoint:params.endpoint,request:params.request},{prisma});
  await requireBillingManager(params.request,prisma);
  const user=await prisma.user.findFirst({where:{id:actor.sub,tokenVersion:actor.tv,lifecycleStatus:'ACTIVE'},select:{id:true}});
  if(!user)throw new AppError('FORBIDDEN',403,'BILLING_SUBJECT_NOT_ENTITLED');
  const selection=await resolveTeamBillingMode(params.request,prisma),env=getEnv();
  const stripeAccountId=selection.mode==='live'?env.STRIPE_LIVE_ACCOUNT_ID:env.STRIPE_SANDBOX_ACCOUNT_ID;
  if(!stripeAccountId)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_MODE_NOT_CONFIGURED');
  const account=await prisma.billingStripeAccount.findUnique({where:{stripeAccountId_livemode:{stripeAccountId,livemode:selection.mode==='live'}}});
  if(!account)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_ACCOUNT_NOT_CONFIGURED');
  assertBillingActionContext(params.request.billingContext,{account,revision:selection.revision,scopeEpoch:selection.epoch,
    appKeyId:params.credential.id},params.endpoint,{product:params.request.product,organisation_id:params.request.organisationId,
      team_id:params.request.teamId,user_id:params.request.userId});
  const creditAccount=await ensureOrganisationCreditAccount({account,organisationId:params.request.organisationId},{prisma});
  return {actor,account,creditAccount,authorizeAction:async(tx:Prisma.TransactionClient)=>{
    await authorizeBillingCustomerAction({credential:params.credential,organisationId:params.request.organisationId,
      teamId:params.request.teamId,userId:params.request.userId,authorityScope:'ORGANISATION',
      operation:BILLING_CUSTOMER_ACTION.CREDIT_AUTO_TOP_UP_DISABLE,actor,request:params.action.request},{prisma:tx});
  }};
}
