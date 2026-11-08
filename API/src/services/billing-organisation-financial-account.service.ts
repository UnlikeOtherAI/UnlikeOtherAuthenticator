import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { OrganisationBillingSelection } from './billing-organisation-mode.service.js';

/** Exact named tuple lookup, independent of provider availability/collection gate. */
export async function organisationFinancialAccount(selection:OrganisationBillingSelection,prisma:PrismaClient) {
  const env=getEnv();
  const stripeAccountId=selection.mode==='live'?env.STRIPE_LIVE_ACCOUNT_ID:env.STRIPE_SANDBOX_ACCOUNT_ID;
  if(!stripeAccountId)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_MODE_NOT_CONFIGURED');
  const account=await prisma.billingStripeAccount.findUnique({where:{stripeAccountId_livemode:{
    stripeAccountId,livemode:selection.mode==='live'}}});
  if(!account)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_ACCOUNT_NOT_CONFIGURED');
  return account;
}
