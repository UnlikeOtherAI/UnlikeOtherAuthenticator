import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingCustomerLocale, BillingOrganisationSectionV1, BillingTeamOverviewV1 }
  from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { authorizeOrganisationBilling, type OrganisationBillingContext } from './billing-organisation-authority.service.js';
import { organisationBillingPeriod } from './billing-organisation-period.service.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import { fetchVerifiedLedgerPaidReceiptSet } from './billing-ledger-paid-receipt-proof.service.js';
import { billingTeamCopy } from './billing-team-copy.catalog.js';
import { readTeamRecordedUsage, readTeamRetainedCredits } from './billing-team-records.service.js';
import { billingLocale } from './billing-copy-locale.js';

async function teamAuthority(context: OrganisationBillingContext, prisma: PrismaClient): Promise<string> {
  const viewer = await authorizeOrganisationBilling(context, prisma);
  if (!context.request.teamId || (!viewer.billingManager && !['owner', 'admin'].includes(viewer.teamRole))) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_TEAM_ACCESS_REQUIRED');
  }
  return context.request.teamId;
}
async function section<T>(read: () => Promise<T>, message: string,
  locale?: BillingCustomerLocale): Promise<BillingOrganisationSectionV1<T>> {
  try { return { state: 'confirmed', message, data: await read() }; }
  catch (error) {
    if (error instanceof AppError && [401, 403].includes(error.statusCode)) throw error;
    const pending = error instanceof AppError && error.statusCode === 409;
    const copy = billingTeamCopy(locale);
    return { state: pending ? 'pending_reconciliation' : 'unavailable',
      code: error instanceof AppError ? error.message : 'BILLING_TEAM_RECORDS_UNAVAILABLE',
      message: pending ? copy.pending : copy.unavailable };
  }
}

/** Selected-team attribution only. No Org money reads, provider calls or writes. */
export async function billingTeamOverview(context: OrganisationBillingContext,
  input: { month?: string; locale?: BillingCustomerLocale } = {}, deps: { prisma?: PrismaClient; now?: Date;
    metering?: typeof fetchLedgerMeteringUsage; proof?: typeof fetchVerifiedLedgerPaidReceiptSet } = {}): Promise<BillingTeamOverviewV1> {
  const prisma = deps.prisma ?? getAdminPrisma(), now = deps.now ?? new Date();
  const teamId = await teamAuthority(context, prisma);
  const period = organisationBillingPeriod(input.month ?? now.toISOString().slice(0, 7), now);
  const team = await prisma.team.findFirst({ where: { id: teamId, orgId: context.request.organisationId,
    lifecycleStatus: 'ACTIVE' }, select: { id: true, name: true } });
  if (!team) throw new AppError('FORBIDDEN', 403, 'BILLING_TEAM_ACCESS_REQUIRED');
  const copy = billingTeamCopy(input.locale);
  const scope = { product: context.request.product, organisationId: context.request.organisationId,
    teamId, billingMonth: period.month, serviceId: context.credential.service.id };
  const metering = (deps.metering ?? fetchLedgerMeteringUsage)({ ...scope, groupBy: 'user' });
  const [activity, recorded_credit_usage, retained_credits] = await Promise.all([
    section(async () => {
      const usage = await metering;
      return { as_of: usage.snapshot.capturedAt, recorded_calls: { quantity: usage.calls,
        display: new Intl.NumberFormat(billingLocale(input.locale)).format(BigInt(usage.calls)), label: copy.calls } };
    }, copy.activity, input.locale),
    section(async () => {
      const usage = await metering, proof = await (deps.proof ?? fetchVerifiedLedgerPaidReceiptSet)(scope);
      return prisma.$transaction(tx => readTeamRecordedUsage(tx, scope, usage, proof, input.locale),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
    }, copy.usage, input.locale),
    section(() => readTeamRetainedCredits(prisma, scope.organisationId, teamId, now, input.locale),
      copy.retained, input.locale),
  ]);
  // A slow reader can never publish data after role removal or team archival.
  if (await teamAuthority(context, prisma) !== teamId) throw new AppError('FORBIDDEN', 403, 'BILLING_TEAM_ACCESS_REQUIRED');
  return { schema_version: 1, generated_at: now.toISOString(),
    subject: { product: scope.product, organisation_id: scope.organisationId, team_id: teamId, user_id: context.request.userId },
    team_scope: { kind: 'team', product: scope.product, organisation_id: scope.organisationId, team_id: teamId },
    title: copy.title, description: copy.description, team,
    product: { id: context.credential.service.id, identifier: context.credential.service.identifier, name: context.credential.service.name },
    period: { month: period.month, starts_at: period.start.toISOString(), ends_at: period.end.toISOString() },
    sections: { activity, recorded_credit_usage, retained_credits } };
}
