import type { PrismaClient } from '@prisma/client';
import type { BillingCustomerLocale } from '../contracts/billing-statement-v1.js';

import { getAdminPrisma } from '../db/prisma.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  resolveCanonicalPortfolioProduct,
  resolveCreditAccount,
  resolveCreditCollectionContext,
} from './billing-credit-account.service.js';
import {
  currentBillingCreditPeriod,
  loadBillingCreditProjectionData,
} from './billing-credit-projection-data.service.js';
import { buildBillingCreditsProjection } from './billing-credit-projection.service.js';
import { resolveBillingCreditActionReadiness } from './billing-credit-action-readiness.service.js';
import { settleCreditPortfolio } from './billing-credit-settlement.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import { resolveBillingControlledBy } from './billing-org-responsibility.service.js';
import {
  buildBillingCreditFundingRequestAction,
  buildBillingCreditAttention,
  resolveLatestBillingFundingCreditEntryId,
  resolveBillingFundingRequestRecipients,
} from './billing-credit-funding-request.service.js';
import { fetchLedgerMeteringPortfolio } from './billing-ledger-collector.service.js';
import type { FetchMeteringPortfolio } from './billing-metering.types.js';
import { AppError } from '../utils/errors.js';

export type BillingCreditsRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

type Dependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  sharedSecret?: string;
  resolveEntitlement?: typeof resolveEffectiveTariffContext;
  resolveCollection?: typeof resolveCreditCollectionContext;
  ensureCreditAccount?: typeof resolveCreditAccount;
  resolvePortfolioProduct?: typeof resolveCanonicalPortfolioProduct;
  fetchPortfolio?: FetchMeteringPortfolio;
  settlePortfolio?: typeof settleCreditPortfolio;
  resolveViewer?: typeof resolveBillingFundingViewer;
  loadProjectionData?: typeof loadBillingCreditProjectionData;
  resolveActionReadiness?: typeof resolveBillingCreditActionReadiness;
  resolveControlledBy?: typeof resolveBillingControlledBy;
  resolveFundingRecipients?: typeof resolveBillingFundingRequestRecipients;
  resolveLatestFundingCreditEntryId?: typeof resolveLatestBillingFundingCreditEntryId;
  hasPendingSettlementWatch?: (creditAccountId: string, teamId: string) => Promise<boolean>;
};

async function hasPendingSettlementWatch(
  creditAccountId: string,
  teamId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  return (await prisma.billingCreditSettlementWatch.count({
    where: {
      creditAccountId,
      teamId,
      OR: [{ lastCheckedAt: null }, { lastError: { not: null } }],
    },
  })) > 0;
}

export async function getBillingCredits(
  params: {
    request: BillingCreditsRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
    locale?: BillingCustomerLocale;
    supportsBillingStatus?: boolean;
  },
  deps?: Dependencies,
) {
  const prisma = deps?.prisma;
  const entitlement = await (deps?.resolveEntitlement ?? resolveEffectiveTariffContext)(
    {
      request: params.request,
      actorToken: params.actorToken,
      credential: params.credential,
      endpoint: params.endpoint,
    },
    { prisma },
  );
  const now = deps?.now?.() ?? new Date();
  const period = currentBillingCreditPeriod(now);
  const collection = await (deps?.resolveCollection ?? resolveCreditCollectionContext)(
    {
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
    },
    { prisma },
  );
  const creditAccount = await (deps?.ensureCreditAccount ?? resolveCreditAccount)(
    {
      account: collection.account,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
    },
    { prisma },
  );
  const portfolioProduct = await (
    deps?.resolvePortfolioProduct ?? resolveCanonicalPortfolioProduct
  )(
    {
      creditAccountId: creditAccount.id,
      teamId: params.request.teamId,
      billingMonth: period.key,
      fallbackProduct: params.credential.service.identifier,
    },
    { prisma },
  );
  let settlementPending = false;
  try {
    const portfolio = await (deps?.fetchPortfolio ?? fetchLedgerMeteringPortfolio)({
      product: portfolioProduct,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
      billingMonth: period.key,
      groupBy: 'user',
    });
    await (deps?.settlePortfolio ?? settleCreditPortfolio)(
      {
        creditAccountId: creditAccount.id,
        portfolio,
        credential: params.credential,
      },
      { prisma },
    );
  } catch (error) {
    if (!(error instanceof AppError) || !(error.message.startsWith('LEDGER_') || [
      'BILLING_CREDIT_LEGACY_RECONCILIATION_REQUIRED',
      'BILLING_CREDIT_PAYER_TRANSITION_RECONCILIATION_REQUIRED',
      'BILLING_CREDIT_HISTORICAL_PAYER_MISMATCH',
      'BILLING_CREDIT_PAYER_HISTORY_MISSING',
      'BILLING_CREDIT_PAYER_PREHISTORY_UNCERTAIN',
    ].includes(error.message))) throw error;
    settlementPending = true;
  }
  settlementPending ||= await (deps?.hasPendingSettlementWatch
    ? deps.hasPendingSettlementWatch(creditAccount.id, params.request.teamId)
    : hasPendingSettlementWatch(creditAccount.id, params.request.teamId, prisma ?? getAdminPrisma()));
  const [viewer, data, controlledBy] = await Promise.all([
    (deps?.resolveViewer ?? resolveBillingFundingViewer)(
      {
        userId: params.request.userId,
        organisationId: params.request.organisationId,
        teamId: params.request.teamId,
      },
      { prisma },
    ),
    (deps?.loadProjectionData ?? loadBillingCreditProjectionData)(
      {
        creditAccountId: creditAccount.id,
        teamId: params.request.teamId,
        accountId: collection.account.id,
        storefrontServiceId: params.credential.service.id,
        period,
      },
      { prisma },
    ),
    (deps?.resolveControlledBy ?? resolveBillingControlledBy)(
      {
        organisationId: params.request.organisationId,
        userId: params.request.userId,
        locale: params.locale,
      },
      { prisma },
    ),
  ]);
  const actionReadiness = await (
    deps?.resolveActionReadiness ?? resolveBillingCreditActionReadiness
  )({ collection, credential: params.credential, data });
  const meteredBilling = Boolean(
    params.locale !== undefined &&
      entitlement.payload.tariff.usage_billing_enabled &&
      entitlement.payload.tariff.payment_collection_enabled,
  );
  const effectiveManager = controlledBy ? controlledBy.can_manage : viewer.billingManager;
  const fundingRecipients =
    params.locale !== undefined && meteredBilling && !effectiveManager
      ? await (
          deps?.resolveFundingRecipients ?? resolveBillingFundingRequestRecipients
        )(
          {
            organisationId: params.request.organisationId,
            teamId: params.request.teamId,
            requesterUserId: viewer.userId,
            organisationPays: Boolean(controlledBy),
          },
          { prisma },
        )
      : [];
  const fundingRequest =
    fundingRecipients.length > 0
      ? buildBillingCreditFundingRequestAction({
          body: {
            product: params.credential.service.identifier,
            organisation_id: viewer.organisationId,
            team_id: viewer.teamId,
            user_id: viewer.userId,
          },
          locale: params.locale,
        })
      : undefined;
  const latestFundingCreditEntryId =
    params.locale !== undefined && meteredBilling
      ? await (
          deps?.resolveLatestFundingCreditEntryId ?? resolveLatestBillingFundingCreditEntryId
        )({ creditAccountId: data.creditAccount.id }, { prisma })
      : null;
  const attention =
    params.locale !== undefined
      ? buildBillingCreditAttention({
          creditAccountId: data.creditAccount.id,
          balanceMicrocredits: data.creditAccount.balanceMicrocredits - data.activeReservedMicrocredits,
          periodKey: period.key,
          meteredBilling,
          account: {
            autoTopUpGeneration: data.creditAccount.autoTopUpGeneration,
            autoTopUpState: data.creditAccount.autoTopUpState,
            autoTopUpThresholdMicrocredits: data.creditAccount.autoTopUpThresholdMicrocredits,
            autoTopUpMonthlyChargeCapMinor: data.creditAccount.autoTopUpMonthlyChargeCapMinor,
            autoTopUpOptionId: data.creditAccount.autoTopUpOptionId,
          },
          policy: data.policy,
          chargedThisMonthMinor: data.autoTopUpChargedMinor,
          latestFundingCreditEntryId,
          paymentMethodExpired: actionReadiness.paymentMethodExpired ?? false,
          secret: deps?.sharedSecret,
        })
      : undefined;
  if (settlementPending && !params.supportsBillingStatus) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_CREDITS_PENDING_RECONCILIATION');
  }
  return buildBillingCreditsProjection({
    locale: params.locale,
    credential: params.credential,
    collection,
    viewer,
    period,
    data,
    now,
    actionReadiness,
    controlledBy,
    attention,
    ...(fundingRequest ? { fundingRequest } : {}),
    settlementPending,
  });
}
