import { createHash } from 'node:crypto';
import { BillingTariffMode, Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { maximumRatedMicrocredits } from './billing-paid-liability.service.js';
import { memoizedBudgetProof, proveHistoricalBudgetScope } from
  './billing-credit-budget-baseline.service.js';

export type VerifiedBudgetContext = {
  contextId: string;
  originProduct: string;
  originSourceDomain: string;
  projectId: string | null;
  runId: string | null;
  runStartedAt?: string | null;
  runOwnerSub?: string | null;
  budgetRunId?: string | null;
  budgetRunStartedAt?: string | null;
  budgetRunOwnerSub?: string | null;
};

export async function assertLedgerBudgetContext(tx: Prisma.TransactionClient, input: {
  product: string; sourceDomain: string; context: VerifiedBudgetContext | null;
  jobGrantId: string | null; originInvocationId: string | null;
}) {
  const value = input.context;
  if (input.jobGrantId) {
    if (!value || value.contextId !== input.originInvocationId) {
      throw new AppError('FORBIDDEN', 403, 'BUDGET_ORIGIN_CONTEXT_MISMATCH');
    }
    const grant = await tx.billingJobComputeRenewal.findUnique({
      where: { id: input.jobGrantId }, select: {
        originProduct: true, originSourceDomain: true, originInvocationId: true,
      },
    });
    if (!grant || grant.originProduct !== value.originProduct
      || grant.originSourceDomain !== value.originSourceDomain
      || grant.originInvocationId !== value.contextId) {
      throw new AppError('FORBIDDEN', 403, 'BUDGET_ORIGIN_CONTEXT_MISMATCH');
    }
  } else if (value && (value.originProduct !== input.product
    || value.originSourceDomain !== input.sourceDomain)) {
    throw new AppError('FORBIDDEN', 403, 'BUDGET_ORIGIN_CONTEXT_MISMATCH');
  }
}

type Scope = { product: string; orgId: string; teamId: string;
  scopeType: 'organization' | 'team' | 'project' | 'run'; scopeId: string };

export async function lockBudgetOrganisation(tx: Prisma.TransactionClient, orgId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(${`billing-credit-budget:${orgId}`}, 0))::text`);
}

export function budgetScopes(input: {
  product: string; orgId: string; teamId: string; context: VerifiedBudgetContext | null;
}): Scope[] {
  const result = new Map<string, Scope>();
  const add = (product: string, scopeType: Scope['scopeType'], scopeId: string) => {
    const scope = { product, orgId: input.orgId, teamId: input.teamId, scopeType, scopeId };
    result.set(`${product}\0${scopeType}\0${scopeId}`, scope);
  };
  add(input.product, 'organization', input.orgId);
  add(input.product, 'team', input.teamId);
  const origin = input.context?.originProduct ?? input.product;
  add(origin, 'organization', input.orgId);
  add(origin, 'team', input.teamId);
  if (input.context?.projectId) add(origin, 'project', input.context.projectId);
  if (input.context?.runId) add(origin, 'run', input.context.runId);
  if (input.context?.budgetRunId) add(origin, 'run', input.context.budgetRunId);
  return [...result.values()].sort((a, b) => Buffer.compare(
    Buffer.from(`${a.product}\0${a.scopeType}\0${a.scopeId}`),
    Buffer.from(`${b.product}\0${b.scopeType}\0${b.scopeId}`)));
}

function windowAt(period: string, date: Date, runBirth?: Date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (period === 'per_run') return { start: runBirth ?? new Date(0), end: null };
  if (period === 'yearly') return {
    start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year + 1, 0, 1)),
  };
  if (period === 'monthly') return {
    start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)),
  };
  if (period === 'weekly') {
    const start = new Date(Date.UTC(year, month, date.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    return { start, end: new Date(start.getTime() + 7 * 24 * 60 * 60_000) };
  }
  throw new AppError('BAD_REQUEST', 400, 'BUDGET_PERIOD_INVALID');
}

export async function budgetScopeTotals(tx: Prisma.TransactionClient,
  scope: Scope, period: string, at: Date,
  deps?: Parameters<typeof proveHistoricalBudgetScope>[4]) {
  const native = period === 'per_run'
    ? await tx.billingCreditBudgetNativeScope.findUnique({ where: {
      product_orgId_scopeType_scopeId: { product: scope.product,
        orgId: scope.orgId, scopeType: scope.scopeType, scopeId: scope.scopeId },
    } }) : null;
  const window = windowAt(period, at,
    native?.teamId === scope.teamId ? native.sourceCreatedAt : undefined);
  const historicalComplete = await proveHistoricalBudgetScope(tx, scope,
    window.start, window.end, deps);
  const rows = await tx.$queryRaw<Array<{ spent: bigint; held: bigint; unknown: bigint }>>(
    Prisma.sql`SELECT
      COALESCE(SUM(CASE WHEN d.status = 'SETTLED'
        THEN COALESCE(l.rated_microcredits, legacy.rated_microcredits, 0)
        ELSE 0 END), 0)::bigint AS spent,
      COALESCE(SUM(CASE WHEN d.status = 'ACTIVE' THEN d.reserved_microcredits ELSE 0 END), 0)::bigint AS held,
      COUNT(*) FILTER (WHERE (d.status = 'ACTIVE' AND d.reserved_microcredits IS NULL)
        OR (d.status = 'SETTLED' AND l.dispatch_id IS NULL
          AND legacy.dispatch_id IS NULL))::bigint AS unknown
      FROM billing_credit_budget_dispatch_scopes AS s
      JOIN billing_credit_budget_dispatches AS d ON d.dispatch_id = s.dispatch_id
      LEFT JOIN billing_paid_usage_liabilities AS l ON l.dispatch_id = s.dispatch_id
      LEFT JOIN billing_credit_budget_legacy_liabilities AS legacy
        ON legacy.dispatch_id = s.dispatch_id
      WHERE s.product = ${scope.product} AND s.org_id = ${scope.orgId}
        AND s.scope_type = ${scope.scopeType} AND s.scope_id = ${scope.scopeId}
        AND s.occurred_at >= ${window.start}
        ${window.end ? Prisma.sql`AND s.occurred_at < ${window.end}` : Prisma.empty}`);
  return { ...window, spent: rows[0]?.spent ?? 0n, held: rows[0]?.held ?? 0n,
    unknown: rows[0]?.unknown ?? 0n, historicalComplete };
}

async function assertCompleteBudgetContext(tx: Prisma.TransactionClient, input: {
  product: string; orgId: string; teamId: string; context: VerifiedBudgetContext | null;
}) {
  const origin = input.context?.originProduct ?? input.product;
  const candidates = await tx.billingCreditBudgetPolicy.findMany({ where: {
    product: origin, orgId: input.orgId, teamId: input.teamId, disabledAt: null,
    mode: { in: ['enforce', 'degrade'] }, scopeType: { in: ['project', 'run'] },
  }, select: { scopeType: true, scopeId: true } });
  const projectCapped = candidates.some((row) => row.scopeType === 'project');
  const runCapped = candidates.some((row) => row.scopeType === 'run');
  const context = input.context;
  if ((projectCapped && !context?.projectId)
    || (runCapped && (!context?.runId || !context.budgetRunId
      || !context.runStartedAt || !context.runOwnerSub
      || !context.budgetRunStartedAt || !context.budgetRunOwnerSub))) {
    throw new AppError('FORBIDDEN', 403, 'BUDGET_CONTEXT_INCOMPLETE');
  }
  const tuples = [
    ...(context?.projectId && candidates.some((row) => row.scopeType === 'project'
      && row.scopeId === context.projectId) ? [{ scopeType: 'project',
      scopeId: context.projectId, born: null, owner: null }] : []),
    ...(runCapped && context?.runId ? [{ scopeType: 'run', scopeId: context.runId,
      born: context.runStartedAt, owner: context.runOwnerSub }] : []),
    ...(runCapped && context?.budgetRunId ? [{ scopeType: 'run',
      scopeId: context.budgetRunId, born: context.budgetRunStartedAt,
      owner: context.budgetRunOwnerSub }] : []),
  ];
  for (const item of tuples) {
    const native = await tx.billingCreditBudgetNativeScope.findUnique({ where: {
      product_orgId_scopeType_scopeId: { product: origin, orgId: input.orgId,
        scopeType: item.scopeType, scopeId: item.scopeId },
    } });
    if (!native || native.teamId !== input.teamId
      || (item.scopeType === 'run' && (native.ownerUserId !== item.owner
        || native.sourceCreatedAt.toISOString() !== item.born))) {
      throw new AppError('FORBIDDEN', 403, 'BUDGET_NATIVE_SCOPE_MISMATCH');
    }
  }
}

export async function reserveBudgetDispatch(tx: Prisma.TransactionClient, input: {
  dispatchId: string; requestFingerprint: string; startedAt: Date; product: string; serviceId: string;
  providerServiceId: string;
  orgId: string; teamId: string; userId: string; billingMonth: string;
  currency: string; tariffId: string; tariffMode: BillingTariffMode;
  markupBps: number; paymentMode: 'PREPAID' | 'PAY_AS_YOU_GO';
  rawCostBound: Prisma.Decimal | null; context: VerifiedBudgetContext | null;
}, deps?: { fetchProof?: Parameters<typeof budgetScopeTotals>[4] extends
    { fetchProof?: infer T } ? T : never }) {
  await lockBudgetOrganisation(tx, input.orgId);
  await assertCompleteBudgetContext(tx, input);
  const scopes = budgetScopes(input);
  const contextDigest = createHash('sha256').update(JSON.stringify({
    dispatchId: input.dispatchId, requestFingerprint: input.requestFingerprint,
    startedAt: input.startedAt.toISOString(),
    product: input.product, serviceId: input.serviceId,
    providerServiceId: input.providerServiceId,
    orgId: input.orgId, teamId: input.teamId, userId: input.userId,
    billingMonth: input.billingMonth, currency: input.currency,
    tariffId: input.tariffId, tariffMode: input.tariffMode,
    markupBps: input.markupBps, paymentMode: input.paymentMode,
    rawCostBound: input.rawCostBound?.toString() ?? null,
    context: input.context,
  })).digest('hex');
  const reserved = input.tariffMode === BillingTariffMode.FREE ? 0n
    : input.rawCostBound === null ? null
      : maximumRatedMicrocredits(input.rawCostBound, input.markupBps);
  const prior = await tx.billingCreditBudgetDispatch.findUnique({
    where: { dispatchId: input.dispatchId },
  });
  if (prior) {
    if (prior.contextDigest !== contextDigest || prior.status !== 'ACTIVE'
      || prior.reservedMicrocredits !== reserved) {
      throw new AppError('BAD_REQUEST', 409, 'BUDGET_DISPATCH_CONFLICT');
    }
    return prior;
  }
  const fetchProof = memoizedBudgetProof(deps?.fetchProof);
  for (const scope of scopes) {
    const policies = await tx.billingCreditBudgetPolicy.findMany({ where: {
      product: scope.product, orgId: scope.orgId, scopeType: scope.scopeType,
      scopeId: scope.scopeId, disabledAt: null, mode: { in: ['enforce', 'degrade'] },
    } });
    for (const policy of policies) {
      const totals = await budgetScopeTotals(tx, scope, policy.period, input.startedAt, {
        fetchProof,
        excludeDispatchId: input.dispatchId,
        excludeRequestFingerprint: input.requestFingerprint,
        excludedAt: input.startedAt,
      });
      if (!totals.historicalComplete || totals.unknown > 0n) {
        throw new AppError('FORBIDDEN', 403, 'BUDGET_EVIDENCE_INCOMPLETE');
      }
      if (reserved === null) throw new AppError('BAD_REQUEST', 422, 'BUDGET_COST_BOUND_REQUIRED');
      if (totals.spent + totals.held + reserved > (policy.limitMicrocredits ?? 0n)) {
        throw new AppError('FORBIDDEN', 402, 'BUDGET_CREDITS_EXHAUSTED');
      }
    }
  }
  const row = await tx.billingCreditBudgetDispatch.create({ data: {
    dispatchId: input.dispatchId, contextDigest,
    serviceId: input.serviceId, providerServiceId: input.providerServiceId,
    orgId: input.orgId, teamId: input.teamId, userId: input.userId,
    billingMonth: input.billingMonth, currency: input.currency,
    tariffId: input.tariffId, frozenMarkupBps: input.markupBps,
    tariffMode: input.tariffMode, paymentMode: input.paymentMode,
    reservedMicrocredits: reserved,
  } });
  await tx.billingCreditBudgetDispatchScope.createMany({ data: scopes.map((scope) => ({
    ...scope, dispatchId: input.dispatchId, occurredAt: input.startedAt,
  })) });
  return row;
}

export async function releaseBudgetDispatch(tx: Prisma.TransactionClient,
  dispatchId: string) {
  const existing = await tx.billingCreditBudgetDispatch.findUnique({ where: { dispatchId } });
  if (!existing || existing.status === 'RELEASED') return;
  if (existing.status !== 'ACTIVE') throw new AppError('BAD_REQUEST', 409, 'BUDGET_DISPATCH_CONFLICT');
  await lockBudgetOrganisation(tx, existing.orgId);
  await tx.billingCreditBudgetDispatch.update({ where: { dispatchId },
    data: { status: 'RELEASED', terminalAt: new Date() },
  });
}

/** Frozen reservations created by the old path may settle after deployment.
 * A migration timestamp cannot identify that path during a rolling rollout.
 * Their org/team
 * liability remains visible; absent project/run evidence still fences finite
 * historical budgets until an explicit Ledger proof backfills those scopes. */
export async function attachLegacyBudgetDispatch(tx: Prisma.TransactionClient, input: {
  dispatchId: string; startedAt: Date; product: string; serviceId: string;
  providerServiceId: string; orgId: string; teamId: string; userId: string;
  billingMonth: string; currency: string; tariffId: string;
  tariffMode: BillingTariffMode; markupBps: number;
  paymentMode: 'PREPAID'; reservedMicrocredits: bigint | null;
}) {
  await lockBudgetOrganisation(tx, input.orgId);
  const source = await tx.billingPrepaidReservation.findUnique({
    where: { dispatchId: input.dispatchId },
  });
  const service = await tx.billingService.findUnique({
    where: { id: input.serviceId }, select: { identifier: true },
  });
  if (!source || source.serviceId !== input.serviceId
    || service?.identifier !== input.product
    || source.providerServiceId !== input.providerServiceId
    || source.orgId !== input.orgId || source.teamId !== input.teamId
    || source.userId !== input.userId || source.billingMonth !== input.billingMonth
    || source.dispatchStartedAt.getTime() !== input.startedAt.getTime()
    || source.currency !== input.currency || source.tariffId !== input.tariffId
    || source.reservedMicrocredits !== input.reservedMicrocredits) {
    throw new AppError('BAD_REQUEST', 409, 'PAID_DISPATCH_EVIDENCE_MISSING');
  }
  const prior = await tx.billingCreditBudgetDispatch.findUnique({
    where: { dispatchId: input.dispatchId },
  });
  if (prior) return prior;
  const contextDigest = createHash('sha256').update(`legacy:${input.dispatchId}`).digest('hex');
  const row = await tx.billingCreditBudgetDispatch.create({ data: {
    dispatchId: input.dispatchId, contextDigest, isLegacy: true,
    serviceId: input.serviceId,
    providerServiceId: input.providerServiceId, orgId: input.orgId,
    teamId: input.teamId, userId: input.userId,
    billingMonth: input.billingMonth, currency: input.currency,
    tariffId: input.tariffId, tariffMode: input.tariffMode,
    frozenMarkupBps: input.markupBps, paymentMode: input.paymentMode,
    reservedMicrocredits: input.reservedMicrocredits,
  } });
  await tx.billingCreditBudgetDispatchScope.createMany({ data: budgetScopes({
    product: input.product, orgId: input.orgId, teamId: input.teamId, context: null,
  }).map((scope) => ({ ...scope, dispatchId: input.dispatchId,
    occurredAt: input.startedAt })) });
  return row;
}
