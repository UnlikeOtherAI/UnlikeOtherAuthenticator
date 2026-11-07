import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { lockBillingAdminEffectAuthority, type BillingAdminEffectActor }
  from './billing-admin-effect-authority.service.js';
import { requireStripeBillingEnabled, type StripeBillingMode }
  from './billing-stripe-client.service.js';

type ModeDb = Pick<Prisma.TransactionClient, 'team' | 'billingTeamMode'>;

export async function resolveTeamBillingMode(
  subject: { organisationId: string; teamId: string },
  prisma: ModeDb = getAdminPrisma(),
): Promise<{ mode: StripeBillingMode; revision: number }> {
  const team = await prisma.team.findFirst({ where: { id: subject.teamId,
    orgId: subject.organisationId, lifecycleStatus: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE' } },
    select: { id: true } });
  if (!team) throw new AppError('NOT_FOUND', 404, 'BILLING_TEAM_NOT_AVAILABLE');
  const policy = await prisma.billingTeamMode.findUnique({ where: { teamId: team.id } });
  return { mode: policy?.sandbox ? 'sandbox' : 'live', revision: policy?.revision ?? 0 };
}

export async function requireTeamStripeBilling(
  subject: { organisationId: string; teamId: string },
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

export async function resolveBillingDisplayBinding(subject: { organisationId: string; teamId: string },
  appKeyId: string, subscriptionId: string | null, prisma: PrismaClient = getAdminPrisma()) {
  const selection = await resolveTeamBillingMode(subject, prisma);
  if (subscriptionId) {
    const subscription = await prisma.billingStripeSubscription.findFirst({ where: {
      id: subscriptionId, orgId: subject.organisationId,
      OR: [{ teamId: subject.teamId }, { teamId: null }] }, include: { account: true } });
    if (!subscription) throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTEXT_STALE');
    return { account: subscription.account, revision: selection.revision, appKeyId };
  }
  const env = getEnv();
  const expectedId = selection.mode === 'live' ? env.STRIPE_LIVE_ACCOUNT_ID : env.STRIPE_SANDBOX_ACCOUNT_ID;
  if (!expectedId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STRIPE_MODE_NOT_CONFIGURED');
  const account = await prisma.billingStripeAccount.findUnique({ where: {
    stripeAccountId_livemode: { stripeAccountId: expectedId, livemode: selection.mode === 'live' } } });
  if (!account) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STRIPE_ACCOUNT_NOT_CONFIGURED');
  return { account, revision: selection.revision, appKeyId };
}

export async function requireOrganisationStripeBilling(organisationId: string,
  prisma: ModeDb = getAdminPrisma()) {
  const team = await prisma.team.findFirst({ where: { orgId: organisationId,
    lifecycleStatus: 'ACTIVE' }, select: { id: true } });
  if (!team) throw new AppError('NOT_FOUND', 404, 'BILLING_TEAM_NOT_AVAILABLE');
  const selected = await requireTeamStripeBilling({ organisationId, teamId: team.id }, prisma);
  await assertOrganisationBillingMode(organisationId, selected.livemode, prisma);
  return selected;
}

/** Organisation money and subscriptions require one mode across all active teams. */
export async function assertOrganisationBillingMode(
  organisationId: string, livemode: boolean, prisma: ModeDb = getAdminPrisma(),
): Promise<void> {
  const teams = await prisma.team.findMany({ where: { orgId: organisationId,
    lifecycleStatus: 'ACTIVE' }, select: { id: true } });
  if (!teams.length) throw new AppError('BAD_REQUEST', 409, 'BILLING_ORGANISATION_MODE_UNAVAILABLE');
  const policies = await prisma.billingTeamMode.findMany({ where: {
    teamId: { in: teams.map((team) => team.id) } }, select: { teamId: true, sandbox: true } });
  const sandbox = new Set(policies.filter((policy) => policy.sandbox).map((policy) => policy.teamId));
  if (teams.some((team) => sandbox.has(team.id) === livemode)) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_ORGANISATION_MODES_MIXED');
  }
}

export type BillingModeBlocker = { code: string; count: number };

export async function readTeamBillingMode(
  subject: { organisationId: string; teamId: string },
  prisma: PrismaClient = getAdminPrisma(),
) {
  const selection = await resolveTeamBillingMode(subject, prisma);
  const blockers = await prisma.$queryRaw<BillingModeBlocker[]>(Prisma.sql`
    SELECT code, count::integer FROM billing_team_mode_blockers(${subject.organisationId}, ${subject.teamId})`);
  return { team_id: subject.teamId, organisation_id: subject.organisationId,
    mode: selection.mode, revision: selection.revision, blockers };
}

export async function setTeamBillingMode(params: {
  organisationId: string; teamId: string; mode: StripeBillingMode; expectedRevision: number;
  actor: BillingAdminEffectActor;
}, prisma: PrismaClient = getAdminPrisma()) {
  await prisma.$transaction(async (tx) => {
    await lockBillingAdminEffectAuthority(tx, params.actor);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id = ${params.organisationId} FOR UPDATE`);
    const current = await resolveTeamBillingMode(params, tx);
    if (current.revision !== params.expectedRevision) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_TEAM_MODE_CHANGED');
    }
    if (current.mode === params.mode) return;
    const blockers = await tx.$queryRaw<BillingModeBlocker[]>(Prisma.sql`
      SELECT code, count::integer FROM billing_team_mode_blockers(${params.organisationId}, ${params.teamId})`);
    if (blockers.length) throw new AppError('BAD_REQUEST', 409, 'BILLING_TEAM_MODE_BLOCKED');
    await tx.billingTeamMode.upsert({ where: { teamId: params.teamId },
      create: { teamId: params.teamId, sandbox: params.mode === 'sandbox', revision: 1 },
      update: { sandbox: params.mode === 'sandbox', revision: { increment: 1 }, updatedAt: new Date() } });
    await tx.adminAuditLog.create({ data: { actorEmail: params.actor.email,
      action: 'billing.team_mode_changed', metadata: { organisation_id: params.organisationId,
        team_id: params.teamId, previous_mode: current.mode, mode: params.mode,
        revision: current.revision + 1, actor_user_id: params.actor.userId ?? null } } });
  });
  return readTeamBillingMode(params, prisma);
}
