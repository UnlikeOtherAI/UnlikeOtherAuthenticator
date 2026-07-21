import type { PrismaClient } from '@prisma/client';

import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  ensureTeamCreditAccount,
  resolveCanonicalPortfolioProduct,
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
import { fetchLedgerMeteringPortfolio } from './billing-ledger-collector.service.js';
import type { FetchMeteringPortfolio } from './billing-metering.types.js';

export type BillingCreditsRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

type Dependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  resolveEntitlement?: typeof resolveEffectiveTariffContext;
  resolveCollection?: typeof resolveCreditCollectionContext;
  ensureCreditAccount?: typeof ensureTeamCreditAccount;
  resolvePortfolioProduct?: typeof resolveCanonicalPortfolioProduct;
  fetchPortfolio?: FetchMeteringPortfolio;
  settlePortfolio?: typeof settleCreditPortfolio;
  resolveViewer?: typeof resolveBillingFundingViewer;
  loadProjectionData?: typeof loadBillingCreditProjectionData;
  resolveActionReadiness?: typeof resolveBillingCreditActionReadiness;
};

export async function getBillingCredits(
  params: {
    request: BillingCreditsRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: Dependencies,
) {
  const prisma = deps?.prisma;
  await (deps?.resolveEntitlement ?? resolveEffectiveTariffContext)(
    {
      request: params.request,
      actorToken: params.actorToken,
      credential: params.credential,
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
  const creditAccount = await (deps?.ensureCreditAccount ?? ensureTeamCreditAccount)(
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
      billingMonth: period.key,
      fallbackProduct: params.credential.service.identifier,
    },
    { prisma },
  );
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
  const [viewer, data] = await Promise.all([
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
        accountId: collection.account.id,
        storefrontServiceId: params.credential.service.id,
        period,
      },
      { prisma },
    ),
  ]);
  const actionReadiness = await (
    deps?.resolveActionReadiness ?? resolveBillingCreditActionReadiness
  )({ collection, credential: params.credential, data });
  return buildBillingCreditsProjection({
    credential: params.credential,
    collection,
    viewer,
    period,
    data,
    now,
    actionReadiness,
  });
}
