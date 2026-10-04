import { BillingAssignmentScope, Prisma, type BillingCreditBudgetPolicy, type PrismaClient } from '@prisma/client';
import type { BillingCreditBudgetWriteV1 } from '@unlikeotherai/billing-statement-protocol';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { type BillingActor, verifyBillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { budgetScopeTotals, lockBudgetOrganisation } from './billing-credit-budget-dispatch.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import { isBillingManager } from './billing-stripe-manager.service.js';
import { billingActorAudience, type BillingActorEndpoint } from './billing-actor-audience.service.js';

const CREDITS = /^(?:0|[1-9]\d*)(?:\.(\d{1,6}))?$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;

function parseCredits(value: string | null): bigint | null {
  if (value === null) return null;
  const match = CREDITS.exec(value);
  if (!match) throw new AppError('BAD_REQUEST', 400, 'BUDGET_CREDITS_INVALID');
  const [whole, part = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(part.padEnd(6, '0'));
  if (amount > MAX_INT64) throw new AppError('BAD_REQUEST', 400, 'BUDGET_CREDITS_TOO_LARGE');
  return amount;
}

function credits(value: bigint): string {
  const whole = value / 1_000_000n;
  const part = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return part ? `${whole}.${part}` : whole.toString();
}

type Subject = { product: string; organisationId: string; teamId: string; userId: string };
type Auth = { credential: VerifiedBillingAppKey; actorToken: string; request: Subject };

async function authorize(auth: Auth, prisma: PrismaClient,
  endpoint: BillingActorEndpoint = '/billing/v1/credit-budgets') {
  if (auth.credential.service.identifier !== auth.request.product) {
    throw new AppError('FORBIDDEN', 403, 'BUDGET_PRODUCT_MISMATCH');
  }
  const actor = await verifyBillingActor({ token: auth.actorToken,
    credential: auth.credential, endpoint,
    request: auth.request });
  const viewer = await resolveBillingFundingViewer({
    userId: auth.request.userId, organisationId: auth.request.organisationId,
    teamId: auth.request.teamId,
  }, { prisma });
  return { actor, viewer };
}

async function lockLiveManager(tx: Prisma.TransactionClient,
  auth: Auth, actor: BillingActor) {
  const rows = await tx.$queryRaw<Array<{ token_version: number;
    org_role: string; team_role: string }>>(Prisma.sql`
    SELECT u.token_version, om.role AS org_role, tm.team_role
    FROM users AS u JOIN org_members AS om ON om.user_id = u.id
      JOIN teams AS t ON t.org_id = om.org_id
      JOIN team_members AS tm ON tm.team_id = t.id AND tm.user_id = u.id
    WHERE u.id = ${auth.request.userId} AND om.org_id = ${auth.request.organisationId}
      AND t.id = ${auth.request.teamId} AND u.lifecycle_status = 'ACTIVE'
      AND om.status = 'ACTIVE' AND tm.status = 'ACTIVE'
    FOR SHARE OF u, om, t, tm`);
  const row = rows[0];
  if (!row || row.token_version !== actor.tv) {
    throw new AppError('FORBIDDEN', 403, 'BUDGET_ACTOR_REVOKED');
  }
  return row;
}

export type NativeBudgetScopeInput = {
  product: string; organization_id: string; team_id: string;
  scope_type: 'project' | 'run'; scope_id: string;
  created_at: string; owner_sub: string | null;
};

export async function registerNativeBudgetScope(auth: Auth, input: NativeBudgetScopeInput,
  deps?: { prisma?: PrismaClient; now?: Date }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const endpoint = '/billing/v1/credit-budgets/scopes';
  const { actor } = await authorize(auth, prisma, endpoint);
  // This first-write endpoint never accepts the transitional generic audience.
  if (actor.aud !== billingActorAudience(endpoint)) {
    throw new AppError('UNAUTHORIZED', 401, 'BUDGET_SCOPE_AUDIENCE_MISMATCH');
  }
  const signed = actor.native_scope;
  const expected = { product: input.product, organization_id: input.organization_id,
    team_id: input.team_id, scope_type: input.scope_type, scope_id: input.scope_id,
    created_at: input.created_at, owner_sub: input.owner_sub };
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)
    || Object.keys(signed).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) =>
      (signed as Record<string, unknown>)[key] !== value)
    || input.product !== auth.request.product
    || input.organization_id !== auth.request.organisationId
    || input.team_id !== auth.request.teamId
    || (input.scope_type === 'run' && input.owner_sub !== actor.sub)
    || (input.scope_type === 'project' && input.owner_sub !== null)) {
    throw new AppError('FORBIDDEN', 403, 'BUDGET_NATIVE_SCOPE_MISMATCH');
  }
  const born = new Date(input.created_at);
  if (!Number.isFinite(born.getTime()) || born.toISOString() !== input.created_at
    || born.getTime() > (deps?.now ?? new Date()).getTime() + 5_000) {
    throw new AppError('BAD_REQUEST', 400, 'BUDGET_NATIVE_SCOPE_BIRTH_INVALID');
  }
  return prisma.$transaction(async (tx) => {
    await lockBudgetOrganisation(tx, input.organization_id);
    const role = await lockLiveManager(tx, auth, actor);
    if (input.scope_type === 'project' && !isBillingManager({
      scope: BillingAssignmentScope.TEAM,
      orgRole: role.org_role, teamRole: role.team_role,
    })) throw new AppError('FORBIDDEN', 403, 'BUDGET_MANAGER_REQUIRED');
    const where = { product_orgId_scopeType_scopeId: {
      product: input.product, orgId: input.organization_id,
      scopeType: input.scope_type, scopeId: input.scope_id,
    } };
    const existing = await tx.billingCreditBudgetNativeScope.findUnique({ where });
    if (existing) {
      if (existing.teamId !== input.team_id
        || existing.sourceCreatedAt.getTime() !== born.getTime()
        || existing.ownerUserId !== input.owner_sub) {
        throw new AppError('BAD_REQUEST', 409, 'BUDGET_NATIVE_SCOPE_CONFLICT');
      }
      return { status: 'registered' as const, scope_type: input.scope_type,
        scope_id: input.scope_id, created_at: input.created_at };
    }
    await tx.billingCreditBudgetNativeScope.create({ data: {
      product: input.product, orgId: input.organization_id,
      teamId: input.team_id, scopeType: input.scope_type,
      scopeId: input.scope_id, sourceCreatedAt: born,
      ownerUserId: input.owner_sub, sourceActorJti: actor.jti,
    } });
    return { status: 'registered' as const, scope_type: input.scope_type,
      scope_id: input.scope_id, created_at: input.created_at };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function validatePolicy(input: BillingCreditBudgetWriteV1) {
  const limit = parseCredits(input.limit_credits);
  if ((input.mode === 'enforce' || input.mode === 'degrade') && limit === null) {
    throw new AppError('BAD_REQUEST', 400, 'BUDGET_LIMIT_REQUIRED');
  }
  if ((input.scope_type === 'run') !== (input.period === 'per_run')
    || (input.scope_type === 'organization' && input.scope_id !== input.organization_id)
    || (input.scope_type === 'team' && input.scope_id !== input.team_id)
    || !Number.isInteger(input.warn_threshold_percent)
    || input.warn_threshold_percent < 0 || input.warn_threshold_percent > 100) {
    throw new AppError('BAD_REQUEST', 400, 'BUDGET_POLICY_INVALID');
  }
  return limit;
}

async function present(tx: Prisma.TransactionClient, row: BillingCreditBudgetPolicy, at: Date) {
  const scope = { product: row.product, orgId: row.orgId, teamId: row.teamId ?? '',
    scopeType: row.scopeType as 'organization' | 'team' | 'project' | 'run',
    scopeId: row.scopeId };
  const totals = await budgetScopeTotals(tx, scope, row.period, at);
  const cutover = await tx.billingCreditBudgetCutover.findUnique({ where: { id: 1 } });
  if (!cutover) throw new AppError('INTERNAL', 503, 'BUDGET_CUTOVER_MISSING');
  const evidenceComplete = totals.start >= cutover.occurredAt && totals.unknown === 0n;
  const used = totals.spent + totals.held;
  const remaining = row.limitMicrocredits === null || !evidenceComplete ? null
    : row.limitMicrocredits > used ? row.limitMicrocredits - used : 0n;
  const percent = row.limitMicrocredits === null || !evidenceComplete ? null
    : row.limitMicrocredits === 0n ? (used === 0n ? 0 : 100)
      : Number((used * 10_000n / row.limitMicrocredits)) / 100;
  return {
    policy_id: row.id, version: row.version,
    scope_type: scope.scopeType, scope_id: row.scopeId,
    period: row.period as 'weekly' | 'monthly' | 'yearly' | 'per_run',
    mode: row.mode as 'off' | 'warn' | 'enforce' | 'degrade' | 'unlimited',
    limit_credits: row.limitMicrocredits === null ? null : credits(row.limitMicrocredits),
    warn_threshold_percent: row.warnThresholdPercent,
    block_humans_when_over: row.blockHumansWhenOver,
    degrade_model: row.degradeModel, degrade_provider: row.degradeProvider,
    spent_credits: credits(totals.spent), held_credits: credits(totals.held),
    remaining_credits: remaining === null ? null : credits(remaining),
    percent_used: percent, evidence_complete: evidenceComplete,
    effective_window_start: totals.start.toISOString(),
    effective_window_end: totals.end?.toISOString() ?? null,
  };
}

export async function listCreditBudgets(auth: Auth, deps?: { prisma?: PrismaClient; now?: Date }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { actor } = await authorize(auth, prisma);
  return prisma.$transaction(async (tx) => {
    const role = await lockLiveManager(tx, auth, actor);
    const orgManager = isBillingManager({ scope: BillingAssignmentScope.ORGANISATION,
      orgRole: role.org_role, teamRole: role.team_role });
    const teamManager = isBillingManager({ scope: BillingAssignmentScope.TEAM,
      orgRole: role.org_role, teamRole: role.team_role });
    const rows = await tx.billingCreditBudgetPolicy.findMany({ where: {
      product: auth.request.product, orgId: auth.request.organisationId,
      disabledAt: null,
      OR: [
        ...(orgManager ? [{ scopeType: 'organization', teamId: null }] : []),
        { scopeType: 'team', teamId: auth.request.teamId },
        ...(teamManager ? [
          { scopeType: 'project', teamId: auth.request.teamId },
          { scopeType: 'run', teamId: auth.request.teamId },
        ] : [{ scopeType: 'run', teamId: auth.request.teamId,
          ownerUserId: auth.request.userId }]),
      ],
    }, orderBy: [{ scopeType: 'asc' }, { scopeId: 'asc' }, { period: 'asc' }] });
    return { schema_version: 1 as const, product: auth.request.product,
      organization_id: auth.request.organisationId, team_id: auth.request.teamId,
      budgets: await Promise.all(rows.map((row) => present(tx, row, deps?.now ?? new Date()))) };
  });
}

export async function putCreditBudget(auth: Auth, input: BillingCreditBudgetWriteV1,
  deps?: { prisma?: PrismaClient; now?: Date }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { actor } = await authorize(auth, prisma);
  if (input.product !== auth.request.product || input.organization_id !== auth.request.organisationId
    || input.team_id !== auth.request.teamId) {
    throw new AppError('FORBIDDEN', 403, 'BUDGET_SCOPE_MISMATCH');
  }
  const limit = validatePolicy(input);
  return prisma.$transaction(async (tx) => {
    await lockBudgetOrganisation(tx, auth.request.organisationId);
    const role = await lockLiveManager(tx, auth, actor);
    const manager = isBillingManager({
      scope: input.scope_type === 'organization'
        ? BillingAssignmentScope.ORGANISATION : BillingAssignmentScope.TEAM,
      orgRole: role.org_role, teamRole: role.team_role,
    });
    const key = { product: input.product, orgId: input.organization_id,
      scopeType: input.scope_type, scopeId: input.scope_id, period: input.period };
    const existing = await tx.billingCreditBudgetPolicy.findUnique({
      where: { product_orgId_scopeType_scopeId_period: key },
    });
    if (existing && existing.teamId !== (input.scope_type === 'organization'
      ? null : input.team_id)) {
      throw new AppError('FORBIDDEN', 403, 'BUDGET_SCOPE_MISMATCH');
    }
    const source = input.scope_type === 'project' || input.scope_type === 'run'
      ? await tx.billingCreditBudgetNativeScope.findUnique({ where: {
        product_orgId_scopeType_scopeId: { product: input.product,
          orgId: input.organization_id, scopeType: input.scope_type,
          scopeId: input.scope_id },
      } }) : null;
    if ((input.scope_type === 'project' || input.scope_type === 'run')
      && (!source || source.teamId !== input.team_id)) {
      throw new AppError('FORBIDDEN', 403, 'BUDGET_SCOPE_EVIDENCE_MISSING');
    }
    if (!manager) {
      if (input.scope_type !== 'run' || input.mode !== 'enforce') {
        throw new AppError('FORBIDDEN', 403, 'BUDGET_MANAGER_REQUIRED');
      }
      if (source?.ownerUserId !== auth.request.userId ||
        (existing && (existing.ownerUserId !== auth.request.userId ||
          (existing.limitMicrocredits !== null && (limit === null || limit > existing.limitMicrocredits))))) {
        throw new AppError('FORBIDDEN', 403, 'BUDGET_RUN_OWNER_REQUIRED');
      }
    }
    if (existing && input.expected_version !== existing.version) {
      throw new AppError('BAD_REQUEST', 409, 'BUDGET_VERSION_CONFLICT');
    }
    if (!existing && input.expected_version !== undefined && input.expected_version !== null) {
      throw new AppError('BAD_REQUEST', 409, 'BUDGET_VERSION_CONFLICT');
    }
    const data = { teamId: input.scope_type === 'organization' ? null : input.team_id,
      mode: input.mode, limitMicrocredits: limit,
      warnThresholdPercent: input.warn_threshold_percent,
      blockHumansWhenOver: input.block_humans_when_over,
      degradeModel: input.degrade_model, degradeProvider: input.degrade_provider,
      ownerUserId: input.scope_type === 'run' ? existing?.ownerUserId ?? auth.request.userId : null,
      disabledAt: null };
    const row = existing
      ? await tx.billingCreditBudgetPolicy.update({ where: { id: existing.id },
        data: { ...data, version: { increment: 1 } } })
      : await tx.billingCreditBudgetPolicy.create({ data: { ...key, ...data } });
    return present(tx, row, deps?.now ?? new Date());
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function deleteCreditBudget(auth: Auth, policyId: string,
  expectedVersion: number, deps?: { prisma?: PrismaClient }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { actor } = await authorize(auth, prisma);
  return prisma.$transaction(async (tx) => {
    await lockBudgetOrganisation(tx, auth.request.organisationId);
    const role = await lockLiveManager(tx, auth, actor);
    const row = await tx.billingCreditBudgetPolicy.findUnique({ where: { id: policyId } });
    if (!row || row.product !== auth.request.product || row.orgId !== auth.request.organisationId
      || (row.teamId !== null && row.teamId !== auth.request.teamId)) {
      throw new AppError('NOT_FOUND', 404, 'BUDGET_POLICY_NOT_FOUND');
    }
    const manager = isBillingManager({ scope: row.scopeType === 'organization'
      ? BillingAssignmentScope.ORGANISATION : BillingAssignmentScope.TEAM,
    orgRole: role.org_role, teamRole: role.team_role });
    if (!manager) {
      throw new AppError('FORBIDDEN', 403, 'BUDGET_MANAGER_REQUIRED');
    }
    if (row.version !== expectedVersion) throw new AppError('BAD_REQUEST', 409, 'BUDGET_VERSION_CONFLICT');
    const updated = await tx.billingCreditBudgetPolicy.update({ where: { id: row.id },
      data: { disabledAt: new Date(), version: { increment: 1 } },
    });
    return { policy_id: updated.id, version: updated.version, status: 'disabled' as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
