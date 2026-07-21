import {
  BillingCreditInvoiceLineStatus,
  BillingCreditUsageSettlementStatus,
  type BillingRecurringAddonSubscriptionScope,
  type PrismaClient,
} from '@prisma/client';

import { AppError } from '../utils/errors.js';

export type ContractCreditSettlementEvidence = {
  accountId: string;
  teamId: string;
  serviceId: string;
  settlementId: string;
  adjustmentId: string;
  creditsAppliedMicrocredits: bigint;
};

export type ContractAddonEvidence = {
  serviceId: string;
  serviceIdentifier: string;
  serviceName: string;
  subscriptionId: string;
  offerId: string;
  offerVersion: number;
  catalogId: string;
  offerKey: string;
  offerName: string;
  monthlyAmountMinor: bigint;
  currency: string;
  scope: BillingRecurringAddonSubscriptionScope;
};

export async function collectContractFundingEvidence(
  params: {
    serviceId: string;
    tariffId: string;
    organisationId: string;
    billingMonth: string;
    startsAt: Date;
    endsAt: Date;
  },
  deps: { prisma: PrismaClient },
): Promise<{
  credits: ContractCreditSettlementEvidence[];
  addons: ContractAddonEvidence[];
}> {
  const [settlements, subscriptions] = await Promise.all([
    deps.prisma.billingCreditUsageSettlement.findMany({
      where: {
        serviceId: params.serviceId,
        tariffId: params.tariffId,
        billingMonth: params.billingMonth,
        status: BillingCreditUsageSettlementStatus.APPLIED,
        creditAccount: { orgId: params.organisationId, currency: 'USD' },
      },
      include: {
        creditAccount: { select: { accountId: true, teamId: true, currency: true } },
        adjustments: {
          orderBy: { sequence: 'desc' },
          take: 1,
          include: {
            currentForLines: {
              where: {
                status: {
                  in: [
                    BillingCreditInvoiceLineStatus.CREATING,
                    BillingCreditInvoiceLineStatus.APPLIED,
                  ],
                },
              },
              select: { id: true },
            },
          },
        },
      },
      orderBy: [{ creditAccountId: 'asc' }, { id: 'asc' }],
    }),
    deps.prisma.billingRecurringAddonSubscription.findMany({
      where: {
        serviceId: params.serviceId,
        orgId: params.organisationId,
        initialInvoicePaidAt: { not: null, lt: params.endsAt },
        entitlementActivatedAt: { not: null, lt: params.endsAt },
        OR: [
          { entitlementDeactivatedAt: null },
          { entitlementDeactivatedAt: { gt: params.startsAt } },
        ],
      },
      include: {
        offer: true,
        catalog: true,
        service: { select: { identifier: true, name: true } },
      },
      orderBy: [{ offerKey: 'asc' }, { scope: 'asc' }, { id: 'asc' }],
    }),
  ]);

  const accountByTeam = new Map<string, string>();
  const credits = settlements.flatMap((settlement) => {
    const latest = settlement.adjustments[0];
    if (!latest) {
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_CREDIT_EVIDENCE_MISSING');
    }
    if (
      settlement.subscriptionId ||
      latest.currentForLines.length > 0 ||
      settlement.creditAccount.currency !== 'USD' ||
      latest.cumulativeCreditsConsumedMicrocredits < 0n
    ) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_CREDIT_COLLECTOR_CONFLICT');
    }
    const teamAccount = accountByTeam.get(settlement.creditAccount.teamId);
    if (teamAccount && teamAccount !== settlement.creditAccount.accountId) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_CREDIT_ACCOUNT_AMBIGUOUS');
    }
    accountByTeam.set(settlement.creditAccount.teamId, settlement.creditAccount.accountId);
    if (latest.cumulativeCreditsConsumedMicrocredits === 0n) return [];
    return [
      {
        accountId: settlement.creditAccount.accountId,
        teamId: settlement.creditAccount.teamId,
        serviceId: settlement.serviceId,
        settlementId: settlement.id,
        adjustmentId: latest.id,
        creditsAppliedMicrocredits: latest.cumulativeCreditsConsumedMicrocredits,
      },
    ];
  });
  const addons = subscriptions.map((subscription) => {
    if (
      !subscription.initialInvoiceId ||
      !subscription.activationWebhookEventId ||
      !subscription.entitlementActivatedAt ||
      subscription.offer.id !== subscription.offerId ||
      subscription.offerKey !== subscription.offer.key ||
      subscription.offer.serviceId !== subscription.serviceId ||
      subscription.catalog.id !== subscription.catalogId ||
      subscription.catalog.serviceId !== subscription.serviceId ||
      subscription.catalog.offerId !== subscription.offerId ||
      subscription.offer.monthlyAmountMinor !== subscription.catalog.monthlyAmountMinor ||
      subscription.offer.currency !== subscription.catalog.currency
    ) {
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_ADDON_EVIDENCE_INVALID');
    }
    return {
      serviceId: subscription.serviceId,
      serviceIdentifier: subscription.service.identifier,
      serviceName: subscription.service.name,
      subscriptionId: subscription.id,
      offerId: subscription.offerId,
      offerVersion: subscription.offer.version,
      catalogId: subscription.catalogId,
      offerKey: subscription.offer.key,
      offerName: subscription.offer.name,
      monthlyAmountMinor: subscription.offer.monthlyAmountMinor,
      currency: subscription.offer.currency,
      scope: subscription.scope,
    };
  });
  return { credits, addons };
}
