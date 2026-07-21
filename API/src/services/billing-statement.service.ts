import { BillingAdjustmentKind, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import {
  BILLING_STATEMENT_SCHEMA_VERSION,
  BILLING_STATEMENT_V2_SCHEMA_VERSION,
  type BillingStatementV1,
  type BillingStatementV2,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { listApplicableCommercialAdjustments } from './billing-commercial-adjustment.service.js';
import {
  fetchLedgerMeteringPortfolio,
  fetchLedgerMeteringUsage,
} from './billing-ledger-collector.service.js';
import {
  type FetchMeteringPortfolio,
  type FetchMeteringUsage,
  type NormalizedMeteringPortfolio,
  type NormalizedMeteringUsage,
} from './billing-metering.types.js';
import { addBillingDecimals, exactMoney, minorAmountToMajor } from './billing-money.service.js';
import {
  listDirectTeamBillingServiceAccess,
  type DirectBillingServiceAccess,
} from './billing-service-access.service.js';
import { billingStatementActions } from './billing-statement-action.service.js';
import {
  buildConnectedServicePortfolio,
  filterPortfolioForProduct,
} from './billing-statement-portfolio.service.js';
import { rateBillingStatementUsage } from './billing-statement-rating.service.js';
import {
  getStripeSubscriptionSummary,
  type BillingSubscriptionRequest,
} from './billing-stripe-subscription.service.js';

type SubscriptionSummary = Awaited<ReturnType<typeof getStripeSubscriptionSummary>>;

type StatementContext = {
  request: BillingSubscriptionRequest;
  actorToken: string;
  credential: VerifiedBillingAppKey;
  billingMonth?: string;
};

type Dependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  resolveSummary?: (params: StatementContext) => Promise<SubscriptionSummary>;
  fetchMetering?: FetchMeteringUsage;
  fetchPortfolio?: FetchMeteringPortfolio;
  listDirectAccess?: typeof listDirectTeamBillingServiceAccess;
};

function monthPeriod(
  billingMonth: string | undefined,
  now: Date,
): BillingStatementV1['period'] & { startsAtDate: Date; endsAtDate: Date } {
  const key =
    billingMonth ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!match) throw new AppError('BAD_REQUEST', 400, 'BILLING_MONTH_INVALID');
  const startsAtDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const endsAtDate = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (startsAtDate > currentMonthStart) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_MONTH_FUTURE');
  }
  return {
    key,
    starts_at: startsAtDate.toISOString(),
    ends_at: endsAtDate.toISOString(),
    state: endsAtDate <= now ? 'closed' : 'open',
    startsAtDate,
    endsAtDate,
  };
}

function modeFromSummary(value: string): 'standard' | 'free' | 'at_cost' | 'custom' {
  if (value === 'free' || value === 'at_cost' || value === 'custom') return value;
  return 'standard';
}

function serviceGraph(
  attributions: Array<{
    billingProduct: string;
    callerProduct: string | null;
    originProduct: string | null;
  }>,
  accesses: DirectBillingServiceAccess[],
  products: Array<{ identifier: string; name: string }> = [],
): BillingStatementV1['services'] {
  const accessByProduct = new Map(accesses.map((access) => [access.product, access]));
  const productNames = new Map(products.map((product) => [product.identifier, product.name]));
  const roles = new Map<string, Set<'billing_product' | 'caller_product' | 'origin_product'>>();
  for (const attribution of attributions) {
    const values: Array<
      [role: 'billing_product' | 'caller_product' | 'origin_product', product: string]
    > = [['billing_product', attribution.billingProduct]];
    if (attribution.callerProduct !== null) {
      values.push(['caller_product', attribution.callerProduct]);
    }
    if (attribution.originProduct !== null) {
      values.push(['origin_product', attribution.originProduct]);
    }
    for (const [role, product] of values) {
      const productRoles = roles.get(product) ?? new Set();
      productRoles.add(role);
      roles.set(product, productRoles);
    }
  }
  for (const access of accesses) {
    if (!roles.has(access.product)) roles.set(access.product, new Set());
  }
  return [...roles.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([product, productRoles]) => {
      const access = accessByProduct.get(product);
      const name = access?.name ?? productNames.get(product) ?? null;
      return {
        product,
        name,
        display_name: name ?? product,
        access: access ? ('direct' as const) : ('indirect' as const),
        direct_user_count: access?.userIds.length ?? 0,
        roles: [...productRoles].sort(),
      };
    });
}

function subscriptionProjection(summary: SubscriptionSummary): BillingStatementV1['subscription'] {
  const subscription = summary.subscription;
  if (!subscription) return null;
  const displayStatus = subscription.cancel_at_period_end
    ? 'Cancels at period end'
    : subscription.status.replaceAll('_', ' ');
  return {
    id: subscription.id,
    status: subscription.status,
    display_status: displayStatus,
    scope: subscription.scope === 'team' ? 'team' : 'organisation',
    cancel_at_period_end: subscription.cancel_at_period_end,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
  };
}

function commercialTotals(
  lines: BillingStatementV1['commercial_lines'],
): BillingStatementV1['totals'] {
  type Parts = {
    monthly: string;
    usage: string;
    addOns: string;
    credits: string;
  };
  const byCurrency = new Map<string, Parts>();
  for (const line of lines) {
    const current = byCurrency.get(line.amount.currency) ?? {
      monthly: '0',
      usage: '0',
      addOns: '0',
      credits: '0',
    };
    const key =
      line.kind === 'monthly_subscription'
        ? 'monthly'
        : line.kind === 'usage'
          ? 'usage'
          : line.kind === 'add_on'
            ? 'addOns'
            : 'credits';
    current[key] = addBillingDecimals(current[key], line.amount.amount);
    byCurrency.set(line.amount.currency, current);
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, parts]) => ({
      currency,
      monthly: exactMoney(parts.monthly, currency),
      usage: exactMoney(parts.usage, currency),
      add_ons: exactMoney(parts.addOns, currency),
      credits: exactMoney(parts.credits, currency),
      total_due: exactMoney(
        [parts.monthly, parts.usage, parts.addOns, parts.credits].reduce(addBillingDecimals, '0'),
        currency,
      ),
    }));
}

async function buildCanonicalBillingStatement(
  context: StatementContext,
  version: 'v1' | 'v2',
  deps?: Dependencies,
): Promise<BillingStatementV1 | BillingStatementV2> {
  const now = deps?.now?.() ?? new Date();
  const period = monthPeriod(context.billingMonth, now);
  const prisma = deps?.prisma ?? getAdminPrisma();
  const summary = await (
    deps?.resolveSummary ?? ((params) => getStripeSubscriptionSummary(params, { prisma }))
  )(context);
  const statementProduct = summary.product.identifier;
  const canonicalRequest = { ...context.request, product: statementProduct };

  const fetchMetering = deps?.fetchMetering ?? fetchLedgerMeteringUsage;
  const fetchPortfolio = deps?.fetchPortfolio ?? fetchLedgerMeteringPortfolio;
  const meteringPromise =
    version === 'v2'
      ? fetchPortfolio({
          product: statementProduct,
          organisationId: context.request.organisationId,
          teamId: context.request.teamId,
          billingMonth: period.key,
          groupBy: 'user',
        }).then((portfolio) => ({ service: portfolio, user: portfolio }))
      : Promise.all([
          fetchMetering({
            product: statementProduct,
            organisationId: context.request.organisationId,
            teamId: context.request.teamId,
            billingMonth: period.key,
            groupBy: 'service',
          }),
          fetchMetering({
            product: statementProduct,
            organisationId: context.request.organisationId,
            teamId: context.request.teamId,
            billingMonth: period.key,
            groupBy: 'user',
          }),
        ]).then(([service, user]) => ({ service, user }));
  const [tariff, products, accesses, adjustments, members, metering] = await Promise.all([
    prisma.billingTariff.findUnique({
      where: { id: summary.tariff.id },
      select: { name: true },
    }),
    prisma.billingService.findMany({
      where: { active: true },
      select: { identifier: true, name: true },
    }),
    (deps?.listDirectAccess ?? listDirectTeamBillingServiceAccess)(
      {
        organisationId: context.request.organisationId,
        teamId: context.request.teamId,
      },
      { prisma },
    ),
    listApplicableCommercialAdjustments(
      {
        serviceId: context.credential.service.id,
        organisationId: context.request.organisationId,
        teamId: context.request.teamId,
        startsAt: period.startsAtDate,
        endsAt: period.endsAtDate,
      },
      { prisma },
    ),
    prisma.teamMember.findMany({
      where: {
        teamId: context.request.teamId,
        status: 'ACTIVE',
        user: {
          orgMembers: {
            some: {
              orgId: context.request.organisationId,
              status: 'ACTIVE',
            },
          },
        },
      },
      select: { user: { select: { id: true, name: true, email: true } } },
    }),
    meteringPromise,
  ]);
  const { service: serviceMetering, user: userMetering } = metering;
  if (!tariff) throw new AppError('INTERNAL', 500, 'BILLING_TARIFF_NOT_FOUND');

  const mode = modeFromSummary(summary.tariff.mode);
  const ratedServiceMetering =
    version === 'v2'
      ? filterPortfolioForProduct(serviceMetering as NormalizedMeteringPortfolio, statementProduct)
      : (serviceMetering as NormalizedMeteringUsage);
  const ratedUserMetering =
    version === 'v2'
      ? filterPortfolioForProduct(userMetering as NormalizedMeteringPortfolio, statementProduct)
      : (userMetering as NormalizedMeteringUsage);
  const rated = rateBillingStatementUsage({
    serviceMetering: ratedServiceMetering,
    userMetering: ratedUserMetering,
    plan: {
      product: statementProduct,
      mode,
      markupBps: summary.tariff.markup_bps,
    },
    users: members.map((member) => member.user),
  });
  const currency = summary.tariff.monthly_subscription.currency;
  const monthlyAmount = minorAmountToMajor(
    summary.tariff.monthly_subscription.amount_minor,
    currency,
  );
  const commercialLines: BillingStatementV1['commercial_lines'] = [
    {
      id: `monthly_${summary.tariff.id}`,
      kind: 'monthly_subscription',
      product: statementProduct,
      label: `${tariff.name} monthly subscription`,
      detail: `Tariff ${summary.tariff.key} v${summary.tariff.version}`,
      amount: exactMoney(monthlyAmount, currency),
    },
    ...rated.commercialLines,
    ...adjustments.map((adjustment) => {
      const amount = minorAmountToMajor(adjustment.amountMinor.toString(), adjustment.currency);
      const signed =
        adjustment.kind === BillingAdjustmentKind.CREDIT && amount !== '0' ? `-${amount}` : amount;
      return {
        id: adjustment.id,
        kind:
          adjustment.kind === BillingAdjustmentKind.CREDIT
            ? ('credit' as const)
            : ('add_on' as const),
        product: statementProduct,
        label: adjustment.name,
        detail: adjustment.cadence === 'MONTHLY' ? 'Monthly adjustment' : 'One-time adjustment',
        amount: exactMoney(signed, adjustment.currency),
      };
    }),
  ];
  const actions = billingStatementActions(summary, canonicalRequest, context.credential);
  const markupPercent = (summary.tariff.markup_bps / 100).toFixed(2);

  const statement: BillingStatementV1 = {
    schema_version: BILLING_STATEMENT_SCHEMA_VERSION,
    statement_id: `bst_${randomUUID()}`,
    generated_at: now.toISOString(),
    product: {
      id: context.credential.service.id,
      identifier: context.credential.service.identifier,
      name: context.credential.service.name,
    },
    subject: summary.subject,
    period: {
      key: period.key,
      starts_at: period.starts_at,
      ends_at: period.ends_at,
      state: period.state,
    },
    pinned_inputs: {
      ledger_snapshots: [serviceMetering, userMetering].map((metering) => ({
        group_by: metering.groupBy,
        cursor: metering.snapshot.cursor,
        id: metering.snapshot.id,
        captured_at: metering.snapshot.capturedAt,
        sha256: metering.snapshot.sha256,
      })),
      tariff: { id: summary.tariff.id, version: summary.tariff.version },
    },
    plan: {
      tariff_id: summary.tariff.id,
      key: summary.tariff.key,
      version: summary.tariff.version,
      name: tariff.name,
      display_name: `${tariff.name} · v${summary.tariff.version}`,
      mode,
      collection_mode: summary.tariff.collection_mode,
      markup_bps: summary.tariff.markup_bps,
      markup_percent: markupPercent,
      markup_display: `${markupPercent}%`,
      usage_multiplier_bps: summary.tariff.usage_price_multiplier_bps,
      monthly_subscription: {
        amount_minor: summary.tariff.monthly_subscription.amount_minor,
        ...exactMoney(monthlyAmount, currency),
      },
      assignment: summary.assignment,
    },
    collection: {
      payment_collection_enabled: summary.tariff.payment_collection_enabled,
      stripe_collection_enabled: summary.stripe_collection_enabled,
      stripe_mode: summary.stripe_mode,
    },
    subscription: subscriptionProjection(summary),
    services: serviceGraph(
      version === 'v2'
        ? (userMetering as NormalizedMeteringPortfolio).lines
        : (serviceMetering as NormalizedMeteringUsage).lines,
      accesses,
      products,
    ),
    usage: rated.usage,
    commercial_lines: commercialLines,
    totals: commercialTotals(commercialLines),
    ...actions,
  };
  if (version === 'v1') return statement;
  const portfolioUserMetering = userMetering as NormalizedMeteringPortfolio;
  return {
    ...statement,
    schema_version: BILLING_STATEMENT_V2_SCHEMA_VERSION,
    pinned_inputs: {
      ledger_snapshots: [
        {
          contract: 'metering-portfolio-v1',
          group_by: 'user',
          cursor: portfolioUserMetering.snapshot.cursor,
          id: portfolioUserMetering.snapshot.id,
          captured_at: portfolioUserMetering.snapshot.capturedAt,
          sha256: portfolioUserMetering.snapshot.sha256,
        },
      ],
      tariff: statement.pinned_inputs.tariff,
    },
    connected_service_usage: buildConnectedServicePortfolio({
      statementProduct,
      userMetering: portfolioUserMetering,
      products,
      accesses,
      users: members.map((member) => member.user),
    }),
  };
}

export async function getCanonicalBillingStatement(
  context: StatementContext,
  deps?: Dependencies,
): Promise<BillingStatementV1> {
  return (await buildCanonicalBillingStatement(context, 'v1', deps)) as BillingStatementV1;
}

export async function getCanonicalBillingStatementV2(
  context: StatementContext,
  deps?: Dependencies,
): Promise<BillingStatementV2> {
  return (await buildCanonicalBillingStatement(context, 'v2', deps)) as BillingStatementV2;
}
