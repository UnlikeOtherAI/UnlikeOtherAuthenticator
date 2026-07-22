import { BillingAssignmentScope, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';

export type CreditCollectionContext = {
  account: StripeAccountContext;
  stripeCollectionEnabled: boolean;
  stripe?: Pick<Stripe, 'paymentIntents' | 'paymentMethods' | 'prices' | 'products'> | null;
};

const CANONICAL_PORTFOLIO_PRODUCTS = ['deeptest', 'deepsignal', 'deepwater', 'nessie'] as const;

async function resolvePersistedCreditAccount(
  params: { organisationId: string; teamId: string },
  prisma: PrismaClient,
): Promise<StripeAccountContext> {
  const scoped = await prisma.billingCreditAccount.findMany({
    where: { orgId: params.organisationId, teamId: params.teamId, currency: 'USD' },
    orderBy: { updatedAt: 'desc' },
    take: 2,
    select: { account: { select: { id: true, stripeAccountId: true, livemode: true } } },
  });
  if (scoped.length > 1) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS');
  }
  if (scoped[0]) return scoped[0].account;

  const persisted = await prisma.billingStripeAccount.findMany({
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
  params: { organisationId: string; teamId: string },
  deps?: { prisma?: PrismaClient },
): Promise<CreditCollectionContext> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (!getEnv().STRIPE_BILLING_ENABLED) {
    const account = await resolvePersistedCreditAccount(params, prisma);
    return { account, stripeCollectionEnabled: false, stripe: null };
  }
  const configured = requireStripeBillingEnabled();
  const account = await resolveStripeAccountContext(configured.client, configured.livemode, prisma);
  return { account, stripeCollectionEnabled: true, stripe: configured.client };
}

export async function ensureTeamCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
    teamId: string;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const scopeKey = `${params.organisationId}:${params.teamId}`;
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
          scope: BillingAssignmentScope.TEAM,
          scopeKey,
        },
        update: {},
      });
      if (
        customer.accountId !== params.account.id ||
        customer.orgId !== params.organisationId ||
        customer.teamId !== params.teamId ||
        customer.scope !== BillingAssignmentScope.TEAM ||
        customer.scopeKey !== scopeKey
      ) {
        throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_CUSTOMER_SCOPE_CONFLICT');
      }
      const creditAccount = await tx.billingCreditAccount.upsert({
        where: {
          accountId_teamId_currency: {
            accountId: params.account.id,
            teamId: params.teamId,
            currency: 'USD',
          },
        },
        create: {
          accountId: params.account.id,
          customerId: customer.id,
          orgId: params.organisationId,
          teamId: params.teamId,
          currency: 'USD',
        },
        update: {},
      });
      if (
        creditAccount.accountId !== params.account.id ||
        creditAccount.customerId !== customer.id ||
        creditAccount.orgId !== params.organisationId ||
        creditAccount.teamId !== params.teamId ||
        creditAccount.currency !== 'USD'
      ) {
        throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_ACCOUNT_SCOPE_CONFLICT');
      }
      return creditAccount;
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}

export async function resolveCanonicalPortfolioProduct(
  params: {
    creditAccountId: string;
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
