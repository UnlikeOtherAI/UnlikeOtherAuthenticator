import { type Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { billingSubscriptionContextObject } from './billing-subscription-context.service.js';
import { readOrganisationBillingMode,resolveOrganisationBillingMode } from './billing-organisation-mode.service.js';
import { type BillingAdminEffectActor }
  from './billing-admin-effect-authority.service.js';
import { requireStripeBillingEnabled, type StripeBillingMode }
  from './billing-stripe-client.service.js';
import { stripeRuntimeForAccount } from './billing-stripe-client.service.js';

type ModeDb = Pick<Prisma.TransactionClient, 'team' | 'organisation' | '$queryRaw'>;

export async function resolveTeamBillingMode(
  subject: { organisationId: string; teamId: string | null },
  prisma: ModeDb = getAdminPrisma(),
) {
  if (subject.teamId===null) return resolveOrganisationBillingMode(subject.organisationId,prisma);
  const team = await prisma.team.findFirst({ where: { id: subject.teamId,
    orgId: subject.organisationId, lifecycleStatus: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE' } },
    select: { id: true } });
  if (!team) throw new AppError('NOT_FOUND', 404, 'BILLING_TEAM_NOT_AVAILABLE');
  return resolveOrganisationBillingMode(subject.organisationId, prisma);
}

export async function requireTeamStripeBilling(
  subject: { organisationId: string; teamId: string | null },
  prisma: ModeDb = getAdminPrisma(),
) {
  const selection = await resolveTeamBillingMode(subject, prisma);
  return { ...requireStripeBillingEnabled(selection.mode), selection };
}

export async function requireStoredStripeBilling(accountId: string,
  prisma: Pick<Prisma.TransactionClient, 'billingStripeAccount'> = getAdminPrisma()) {
  const account = await prisma.billingStripeAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STRIPE_ACCOUNT_NOT_CONFIGURED');
  return requireStripeBillingEnabled(account);
}
/** Reads and captured recovery use their credential tuple even while new collection is disabled. */
export async function storedStripeBillingReader(accountId:string,
  prisma:Pick<Prisma.TransactionClient,'billingStripeAccount'>=getAdminPrisma()) {
  const account=await prisma.billingStripeAccount.findUnique({where:{id:accountId}});
  if(!account)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_ACCOUNT_NOT_CONFIGURED');
  return stripeRuntimeForAccount(account);
}

export async function resolveBillingDisplayBinding(subject: { organisationId: string; teamId: string | null },
  appKeyId: string, subscriptionId: string | null, prisma: PrismaClient = getAdminPrisma()) {
  const selection = await resolveTeamBillingMode(subject, prisma);
  if (subscriptionId) {
    const subscription = await prisma.billingStripeSubscription.findFirst({ where: {
      id: subscriptionId, orgId: subject.organisationId }, include: { account: true } });
    if (!subscription) throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTEXT_STALE');
    return { account: subscription.account, revision: selection.revision, scopeEpoch: selection.epoch, appKeyId,
      objectBinding:billingSubscriptionContextObject(subscription) };
  }
  const env = getEnv();
  const expectedId = selection.mode === 'live' ? env.STRIPE_LIVE_ACCOUNT_ID : env.STRIPE_SANDBOX_ACCOUNT_ID;
  if (!expectedId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STRIPE_MODE_NOT_CONFIGURED');
  const account = await prisma.billingStripeAccount.findUnique({ where: {
    stripeAccountId_livemode: { stripeAccountId: expectedId, livemode: selection.mode === 'live' } } });
  if (!account) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STRIPE_ACCOUNT_NOT_CONFIGURED');
  return { account, revision: selection.revision, scopeEpoch: selection.epoch, appKeyId };
}

export async function requireOrganisationStripeBilling(organisationId: string,
  prisma: ModeDb = getAdminPrisma()) {
  const selection=await resolveOrganisationBillingMode(organisationId,prisma);
  return {...requireStripeBillingEnabled(selection.mode),selection};
}

/** Team admission does not select the organisation's financial mode. */
export async function assertOrganisationBillingMode(
  organisationId: string, livemode: boolean, prisma: ModeDb = getAdminPrisma(),
): Promise<void> {
  const selected = await resolveOrganisationBillingMode(organisationId, prisma);
  if ((selected.mode === 'live') !== livemode) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_ORGANISATION_MODE_CHANGED');
  }
}

// Legacy routes remain discoverable, but cannot change retired team policy.
export async function readTeamBillingMode(subject: { organisationId: string; teamId: string | null },
  prisma: PrismaClient = getAdminPrisma()) {
  const selection = await resolveTeamBillingMode(subject,prisma);
  const current=await readOrganisationBillingMode(subject.organisationId,prisma);
  return {...current,...selection,team_id:subject.teamId,controlling_scope:'organisation' as const};
}
export async function setTeamBillingMode(_params: {
  organisationId:string;teamId:string;mode:StripeBillingMode;expectedRevision:number;actor:BillingAdminEffectActor;
},_prisma:PrismaClient=getAdminPrisma()):Promise<never> {
  throw new AppError('BAD_REQUEST',409,'BILLING_ORGANISATION_MODE_REQUIRED');
}
