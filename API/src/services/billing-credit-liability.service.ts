import { BillingAppKeyPurpose, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { resolveCanonicalPortfolioProduct, resolveCreditAccount } from './billing-credit-account.service.js';
import { settleCreditPortfolio } from './billing-credit-settlement.service.js';
import { fetchLedgerMeteringPortfolio } from './billing-ledger-collector.service.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';

type LiabilitySubscription = {
  accountId: string;
  orgId: string;
  teamId: string | null;
  serviceId: string;
  tariffId: string;
  service: { identifier: string };
};

/**
 * Refreshes each source team's immutable Ledger portfolio before calculating
 * the cumulative credit offset for one metered subscription. The account that
 * supplies credits may be team- or organisation-owned; settlement identity is
 * always the source team. Accepted or reserved Stripe liability caps further
 * prepaid allocation, so a later top-up cannot debit already exported usage.
 */
export async function settleSubscriptionCreditLiability(
  params: {
    subscription: LiabilitySubscription;
    account: StripeAccountContext;
    billingMonth: string;
  },
  deps?: {
    prisma?: PrismaClient;
    fetchPortfolio?: typeof fetchLedgerMeteringPortfolio;
    settlePortfolio?: typeof settleCreditPortfolio;
    resolveAccount?: typeof resolveCreditAccount;
  },
): Promise<bigint> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const teams = params.subscription.teamId
    ? [{ id: params.subscription.teamId }]
    : await prisma.team.findMany({
        where: { orgId: params.subscription.orgId },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
  const key = await prisma.billingAppKey.findFirst({
    where: {
      serviceId: params.subscription.serviceId,
      purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: { service: { select: { id: true, identifier: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  if (!key) throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_SETTLEMENT_KEY_MISSING');
  for (const team of teams) {
    const creditAccount = await (deps?.resolveAccount ?? resolveCreditAccount)({
      account: params.account,
      organisationId: params.subscription.orgId,
      teamId: team.id,
    }, { prisma });
    const product = await resolveCanonicalPortfolioProduct({
      creditAccountId: creditAccount.id,
      teamId: team.id,
      billingMonth: params.billingMonth,
      fallbackProduct: params.subscription.service.identifier,
    }, { prisma });
    const portfolio = await (deps?.fetchPortfolio ?? fetchLedgerMeteringPortfolio)({
      product,
      organisationId: params.subscription.orgId,
      teamId: team.id,
      billingMonth: params.billingMonth,
      groupBy: 'user',
    });
    await (deps?.settlePortfolio ?? settleCreditPortfolio)({
      creditAccountId: creditAccount.id,
      portfolio,
      credential: {
        id: key.id,
        purpose: key.purpose,
        actorIssuer: key.actorIssuer,
        actorAudience: key.actorAudience,
        actorKeyId: key.actorKeyId,
        actorPublicJwk: key.actorPublicJwk,
        checkoutReturnOrigins: key.checkoutReturnOrigins,
        service: key.service,
      },
    }, { prisma });
  }
  const settlements = await prisma.billingCreditUsageSettlement.findMany({
    where: {
      accountId: params.account.id,
      teamId: { in: teams.map((team) => team.id) },
      serviceId: params.subscription.serviceId,
      billingMonth: params.billingMonth,
    },
    select: {
      tariffId: true,
      cumulativeCreditsConsumedMicrocredits: true,
      cumulativeRatedUsageAmountMicroMinor: true,
    },
  });
  if (settlements.some((row) => row.tariffId !== params.subscription.tariffId)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_SUBSCRIPTION_TARIFF_MISMATCH');
  }
  return settlements.reduce(
    (total, row) => total + row.cumulativeCreditsConsumedMicrocredits / 10n,
    0n,
  );
}
