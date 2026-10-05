import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingStatementCopy } from './billing-statement-copy.catalog.js';
import { billingSubscriptionCopy } from './billing-subscription-copy.catalog.js';
import {
  BillingAdjustmentKind,
  MembershipStatus,
  type PrismaClient,
} from '@prisma/client';

import type {
  BillingOrganisationScopeV1,
  BillingOrganisationTeamUsageV1,
  BillingStatementV1,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { listApplicableCommercialAdjustments } from './billing-commercial-adjustment.service.js';
import { fetchLedgerMeteringPortfolio } from './billing-ledger-collector.service.js';
import type { FetchMeteringPortfolio } from './billing-metering.types.js';
import { exactMoney, minorAmountToMajor } from './billing-money.service.js';
import { resolveBillingTariffForMonth } from './billing-tariff-history.service.js';
import {
  filterPortfolioForProduct,
} from './billing-statement-portfolio.service.js';
import {
  billingCommercialTotals,
  rateBillingStatementUsage,
} from './billing-statement-rating.service.js';

/**
 * The organisation roll-up (Docs/plans/2026-08-15-org-billing-override.md §3).
 *
 * Every team is rated by the pipeline that already rates one team, from that
 * team's own pinned `metering-portfolio-v1` snapshot, and the organisation
 * totals are the existing `commercial_lines` summation over every team's lines.
 * No new rating and no new arithmetic: an organisation total is the sum of the
 * team totals by construction, which is the property the design owes.
 *
 * It is returned *beside* the requested team's own statement rather than in
 * place of it. A consumer that predates `organisation_scope` therefore keeps
 * reading truthful per-team numbers, instead of silently reading
 * organisation-wide ones as if they were the team's.
 */
export type OrganisationStatementContext = {
  organisationId: string;
  serviceId: string;
  statementProduct: string;
  billingMonth: string;
  periodStartsAt: Date;
  periodEndsAt: Date;
  products: Array<{ identifier: string; name: string }>;
  locale?: BillingCustomerLocale;
};

type Dependencies = {
  prisma: PrismaClient;
  fetchPortfolio?: FetchMeteringPortfolio;
};

type TeamTariff = {
  id: string;
  key: string;
  name: string;
  version: number;
  mode: 'standard' | 'free' | 'at_cost' | 'custom';
  markupBps: number;
  monthlyAmountMinor: bigint;
  currency: string;
};

function publicMode(value: string): TeamTariff['mode'] {
  const lower = value.toLowerCase();
  if (lower === 'free' || lower === 'at_cost' || lower === 'custom') return lower;
  return 'standard';
}

/**
 * The tariff that applies to one team: its own assignment, else the
 * organisation's, else the service default — the exact precedence
 * `resolveEffectiveTariffContext` applies for a single team, asked here without
 * an actor because the caller's authority has already been established at the
 * organisation.
 */
async function resolveTeamTariff(
  params: { serviceId: string; organisationId: string; teamId: string; billingMonth: string },
  prisma: PrismaClient,
): Promise<TeamTariff> {
  const { tariff } = await resolveBillingTariffForMonth(prisma, params);
  return {
    id: tariff.id,
    key: tariff.key,
    name: tariff.name,
    version: tariff.version,
    mode: publicMode(tariff.mode),
    markupBps: tariff.markupBps,
    monthlyAmountMinor: tariff.monthlyAmountMinor,
    currency: tariff.currency,
  };
}

function teamCommercialLines(params: {
  statementProduct: string;
  teamId: string;
  tariff: TeamTariff;
  ratedLines: BillingStatementV1['commercial_lines'];
  adjustments: Awaited<ReturnType<typeof listApplicableCommercialAdjustments>>;
  locale?: BillingCustomerLocale;
}): BillingStatementV1['commercial_lines'] {
  const monthlyAmount = minorAmountToMajor(
    params.tariff.monthlyAmountMinor.toString(),
    params.tariff.currency,
  );
  return [
    {
      id: `monthly_${params.tariff.id}_${params.teamId}`,
      kind: 'monthly_subscription',
      product: params.statementProduct,
      label: billingStatementCopy(params.locale).monthlySubscription,
      detail: billingStatementCopy(params.locale).subscriptionDetails,
      amount: exactMoney(monthlyAmount, params.tariff.currency, params.locale),
    },
    ...params.ratedLines.map((line) => ({ ...line, id: `${line.id}_${params.teamId}` })),
    ...params.adjustments.map((adjustment) => {
      const amount = minorAmountToMajor(adjustment.amountMinor.toString(), adjustment.currency);
      const signed =
        adjustment.kind === BillingAdjustmentKind.CREDIT && amount !== '0' ? `-${amount}` : amount;
      return {
        id: adjustment.id,
        kind:
          adjustment.kind === BillingAdjustmentKind.CREDIT
            ? ('credit' as const)
            : ('add_on' as const),
        product: params.statementProduct,
        label: adjustment.kind === BillingAdjustmentKind.CREDIT
          ? billingStatementCopy(params.locale).credit : billingStatementCopy(params.locale).additionalCharge,
        detail: adjustment.cadence === 'MONTHLY'
          ? billingSubscriptionCopy(params.locale).monthlyAdjustment
          : billingSubscriptionCopy(params.locale).oneTimeAdjustment,
        amount: exactMoney(signed, adjustment.currency, params.locale),
      };
    }),
  ];
}

async function buildTeamUsage(
  context: OrganisationStatementContext,
  team: { id: string; name: string },
  deps: Dependencies,
): Promise<BillingOrganisationTeamUsageV1> {
  const fetchPortfolio = deps.fetchPortfolio ?? fetchLedgerMeteringPortfolio;
  const [portfolio, tariff, adjustments, members] = await Promise.all([
    fetchPortfolio({
      product: context.statementProduct,
      organisationId: context.organisationId,
      teamId: team.id,
      billingMonth: context.billingMonth,
      groupBy: 'user',
    }),
    resolveTeamTariff(
      {
        serviceId: context.serviceId,
        organisationId: context.organisationId,
        teamId: team.id,
        billingMonth: context.billingMonth,
      },
      deps.prisma,
    ),
    listApplicableCommercialAdjustments(
      {
        serviceId: context.serviceId,
        organisationId: context.organisationId,
        teamId: team.id,
        startsAt: context.periodStartsAt,
        endsAt: context.periodEndsAt,
      },
      { prisma: deps.prisma },
    ),
    deps.prisma.teamMember.findMany({
      where: {
        teamId: team.id,
        status: MembershipStatus.ACTIVE,
        user: {
          orgMembers: {
            some: { orgId: context.organisationId, status: MembershipStatus.ACTIVE },
          },
        },
      },
      select: { user: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  const productMetering = filterPortfolioForProduct(portfolio, context.statementProduct);
  const rated = rateBillingStatementUsage({
    serviceMetering: productMetering,
    userMetering: productMetering,
    plan: {
      product: context.statementProduct,
      mode: tariff.mode,
      markupBps: tariff.markupBps,
    },
    users: members.map((member) => member.user),
    locale: context.locale,
  });
  const commercialLines = teamCommercialLines({
    statementProduct: context.statementProduct,
    teamId: team.id,
    tariff,
    ratedLines: rated.commercialLines,
    adjustments,
    locale: context.locale,
  });
  return {
    team_id: team.id,
    team_name: team.name,
    display_name: team.name,
    pinned_ledger_snapshot: {
      contract: 'metering-portfolio-v1',
      group_by: 'user',
      cursor: portfolio.snapshot.cursor,
      id: portfolio.snapshot.id,
      captured_at: portfolio.snapshot.capturedAt,
      sha256: portfolio.snapshot.sha256,
    },
    commercial_lines: commercialLines,
    totals: billingCommercialTotals(commercialLines, context.locale),
  };
}

export async function buildOrganisationStatementScope(
  context: OrganisationStatementContext,
  deps: Dependencies,
): Promise<BillingOrganisationScopeV1> {
  const organisation = await deps.prisma.organisation.findUnique({
    where: { id: context.organisationId },
    select: { id: true, name: true },
  });
  if (!organisation) throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  const teams = await deps.prisma.team.findMany({
    where: { orgId: context.organisationId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const teamUsage = await Promise.all(teams.map((team) => buildTeamUsage(context, team, deps)));
  const commercialLines = teamUsage.flatMap((team) => team.commercial_lines);
  return {
    organisation_id: organisation.id,
    organisation_name: organisation.name,
    title: billingSubscriptionCopy(context.locale).organisationTitle,
    description: billingSubscriptionCopy(context.locale).organisationDescription,
    teams: teamUsage,
    commercial_lines: commercialLines,
    totals: billingCommercialTotals(commercialLines, context.locale),
  };
}
