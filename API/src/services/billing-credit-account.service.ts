import { requireTeamStripeBilling, resolveTeamBillingMode, assertOrganisationBillingMode } from './billing-team-mode.service.js';
import { BillingAssignmentScope, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { resolveOrgBillingResponsibility } from './billing-org-responsibility.service.js';

export type CreditCollectionContext = {
  account: StripeAccountContext;
  modeRevision?: number;
  scopeEpoch?: string;
  stripeCollectionEnabled: boolean;
  stripe?: Pick<
    Stripe,
    'checkout' | 'paymentIntents' | 'paymentMethods' | 'prices' | 'products' | 'rawRequest'
  > | null;
};

const CANONICAL_PORTFOLIO_PRODUCTS = [
  'deeptest',
  'deepsignal',
  'deepwater',
  'docgen',
  'nessie',
] as const;

async function resolvePersistedCreditAccount(
  params: { organisationId: string; teamId: string | null },
  prisma: PrismaClient,
): Promise<StripeAccountContext> {
  const selection = await resolveTeamBillingMode(params, prisma);
  const env = getEnv();
  const expectedId = selection.mode === 'live' ? env.STRIPE_LIVE_ACCOUNT_ID : env.STRIPE_SANDBOX_ACCOUNT_ID;
  if(!expectedId)throw new AppError('SERVICE_UNAVAILABLE',503,'BILLING_STRIPE_MODE_NOT_CONFIGURED');
  const identity = { livemode: selection.mode === 'live',
    stripeAccountId: expectedId };
  const scoped = await prisma.billingCreditAccount.findMany({
    where: {
      account: identity,
      orgId: params.organisationId,
      scope: BillingAssignmentScope.ORGANISATION, teamId: null,
      currency: 'USD',
    },
    orderBy: { updatedAt: 'desc' },
    take: 2,
    select: { account: { select: { id: true, stripeAccountId: true, livemode: true } } },
  });
  if (scoped.length > 1) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS');
  }
  if (scoped[0]) return scoped[0].account;

  const persisted = await prisma.billingStripeAccount.findMany({
    where: identity,
    orderBy: { updatedAt: 'desc' },
    take: 2,
    select: { id: true, stripeAccountId: true, livemode: true },
  });
  if (persisted.length !== 1) {
    throw new AppError(
      'BAD_REQUEST',
      409,
      persisted.length > 1
        ? 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS'
        : 'BILLING_CREDIT_ACCOUNT_NOT_PROVISIONED',
    );
  }
  const account = persisted[0];
  if (!account) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_NOT_PROVISIONED');
  }
  return account;
}

export async function resolveCreditCollectionContext(
  params: { organisationId: string; teamId: string | null },
  deps?: { prisma?: PrismaClient },
): Promise<CreditCollectionContext> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (!getEnv().STRIPE_BILLING_ENABLED) {
    const account = await resolvePersistedCreditAccount(params, prisma);
    const selection = await resolveTeamBillingMode(params, prisma);
    return { account, modeRevision: selection.revision, scopeEpoch: selection.epoch, stripeCollectionEnabled: false, stripe: null };
  }
  const configured = await requireTeamStripeBilling(params, prisma);
  const account = await resolveStripeAccountContext(configured.client, configured.livemode, prisma);
  return { account, modeRevision: configured.selection.revision, scopeEpoch: configured.selection.epoch,
    stripeCollectionEnabled: true, stripe: configured.client };
}

async function ensureScopedCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
    teamId: string | null;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const scope =
    params.teamId === null ? BillingAssignmentScope.ORGANISATION : BillingAssignmentScope.TEAM;
  const scopeKey =
    params.teamId === null ? params.organisationId : `${params.organisationId}:${params.teamId}`;
  return runBillingSerializableTransaction(
    prisma,
    async (tx) => {
      const customer = await tx.billingStripeCustomer.upsert({
        where: {
          accountId_scopeKey: { accountId: params.account.id, scopeKey },
        },
        create: {
          accountId: params.account.id,
          orgId: params.organisationId,
          teamId: params.teamId,
          scope,
          scopeKey,
        },
        update: {},
      });
      if (
        customer.accountId !== params.account.id ||
        customer.orgId !== params.organisationId ||
        customer.teamId !== params.teamId ||
        customer.scope !== scope ||
        customer.scopeKey !== scopeKey
      ) {
        throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_CUSTOMER_SCOPE_CONFLICT');
      }
      const creditAccount = await tx.billingCreditAccount.upsert({
        where: {
          accountId_scopeKey_currency: {
            accountId: params.account.id,
            scopeKey,
            currency: 'USD',
          },
        },
        create: {
          accountId: params.account.id,
          customerId: customer.id,
          orgId: params.organisationId,
          teamId: params.teamId,
          scope,
          scopeKey,
          currency: 'USD',
        },
        update: {},
      });
      if (
        creditAccount.accountId !== params.account.id ||
        creditAccount.customerId !== customer.id ||
        creditAccount.orgId !== params.organisationId ||
        creditAccount.teamId !== params.teamId ||
        creditAccount.scope !== scope ||
        creditAccount.scopeKey !== scopeKey ||
        creditAccount.currency !== 'USD'
      ) {
        throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_ACCOUNT_SCOPE_CONFLICT');
      }
      return creditAccount;
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}

export async function ensureTeamCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
    teamId: string | null;
  },
  deps?: { prisma?: PrismaClient },
) {
  return ensureScopedCreditAccount(params, deps);
}

export async function ensureOrganisationCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
  },
  deps?: { prisma?: PrismaClient },
) {
  return ensureScopedCreditAccount({ ...params, teamId: null }, deps);
}

/**
 * The single chokepoint every credit debit crosses.
 *
 * Every forward debit uses the organisation wallet in its selected account
 * and mode. Retained responsibility rows and TEAM wallets remain historical
 * recovery evidence; neither the selected team nor an optional roll-up chooses
 * the current payer. No financial record is moved by this resolver.
 */
export async function resolveCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
    teamId: string | null;
  },
  deps?: { prisma?: PrismaClient; resolveResponsibility?: typeof resolveOrgBillingResponsibility },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  await assertOrganisationBillingMode(params.organisationId,params.account.livemode,prisma);
  return ensureOrganisationCreditAccount({account:params.account,organisationId:params.organisationId},{prisma});
}

export async function resolveCanonicalPortfolioProduct(
  params: {
    creditAccountId: string;
    teamId: string | null;
    billingMonth: string;
    fallbackProduct: string;
  },
  deps?: { prisma?: PrismaClient },
): Promise<string> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [existing, activeServices] = await Promise.all([
    prisma.billingCreditPortfolioSnapshot.findFirst({
      where: {
        creditAccountId: params.creditAccountId,
        ...(params.teamId===null?{}:{teamId:params.teamId}),
        billingMonth: params.billingMonth,
      },
      orderBy: [{ capturedAt: 'desc' }, { ledgerSnapshotCursor: 'desc' }],
      select: { perspectiveProduct: true },
    }),
    prisma.billingService.findMany({
      where: {
        active: true,
        identifier: { in: [...CANONICAL_PORTFOLIO_PRODUCTS] },
      },
      orderBy: { identifier: 'asc' },
      select: { identifier: true },
    }),
  ]);
  return existing?.perspectiveProduct ?? activeServices[0]?.identifier ?? params.fallbackProduct;
}
