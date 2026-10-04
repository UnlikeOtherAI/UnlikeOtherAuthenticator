import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Prisma, type PrismaClient } from '@prisma/client';
import { compactVerify, createLocalJWKSet, createRemoteJWKSet } from 'jose';
import { z } from 'zod';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { fetchLedgerRawBudgetReceiptSet, fetchLedgerRawPaidReceiptSet } from
  './billing-ledger-collector.service.js';

type Reader = PrismaClient | Prisma.TransactionClient;
type KeyResolver = ReturnType<typeof createRemoteJWKSet> |
  ReturnType<typeof createLocalJWKSet>;
const decimalCount = z.string().regex(/^(?:0|[1-9]\d*)$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSetSchema = z.object({
  contract: z.literal('ledger-paid-receipt-set-v1'),
  scope: z.object({ billing_product: z.string().min(1),
    organization_id: z.string().min(1), team_id: z.string().min(1),
    billing_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict(),
  snapshot: z.object({ cursor: z.string().regex(/^mpr_[A-Za-z0-9_-]{32}$/),
    captured_at: z.string().datetime({ offset: true }), immutable: z.literal(true) }).strict(),
  paid_receipt_count: decimalCount, paid_receipt_sha256: hash,
  zero_incremental_count: decimalCount, zero_incremental_sha256: hash,
  unresolved_paid_attempts: decimalCount,
  signature: z.string().min(100),
}).strict();
const budgetReceiptSetSchema = receiptSetSchema.extend({
  contract: z.literal('ledger-budget-receipt-set-v1'),
  scope: receiptSetSchema.shape.scope.extend({
    team_id: z.string().min(1).nullable(),
    budget_scope_type: z.literal('organization').optional(),
    exclude_dispatch_id: z.string().min(1).max(160).optional(),
    exclude_request_fingerprint: hash.optional(),
    exclude_team_id: z.string().min(1).optional(),
    native_scope_type: z.enum(['project', 'run']).optional(),
    native_scope_id: z.string().min(1).max(256).optional(),
    native_born_at: z.string().datetime({ offset: true }).optional(),
    native_owner_sub: z.string().min(1).optional(),
  }).strict(),
  pending_dispatch_count: decimalCount,
  pending_dispatch_sha256: hash,
});

export type LedgerPaidReceiptSet = z.infer<typeof receiptSetSchema>;
export type LedgerBudgetReceiptSet = z.infer<typeof budgetReceiptSetSchema>;
export type PaidReceiptScope = { product: string; organisationId: string;
  teamId: string; billingMonth: string; serviceId: string };
export type BudgetReceiptScope = Omit<PaidReceiptScope, 'serviceId' | 'teamId'> & {
  teamId: string | null; budgetScopeType?: 'organization';
  excludeDispatchId?: string; excludeRequestFingerprint?: string;
  excludeTeamId?: string;
  nativeScopeType?: 'project' | 'run'; nativeScopeId?: string;
  nativeBornAt?: string; nativeOwnerSub?: string };

const jwksByUrl = new Map<string, KeyResolver>();

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function actorKeys(): KeyResolver {
  const base = getEnv().LEDGER_BILLING_BASE_URL;
  if (!base) hold('LEDGER_PAID_RECEIPT_SET_READER_DISABLED');
  const url = new URL('/.well-known/jwks.json', base);
  const key = url.toString();
  let keys = jwksByUrl.get(key);
  if (!keys) {
    keys = createRemoteJWKSet(url, { cooldownDuration: 30_000, cacheMaxAge: 300_000 });
    jwksByUrl.set(key, keys);
  }
  return keys;
}

async function verifySignedReceiptSet<T extends LedgerPaidReceiptSet | LedgerBudgetReceiptSet>(
  proof: T, scope: BudgetReceiptScope, typ: string, code: string, keys: KeyResolver,
): Promise<T> {
  let signed: unknown;
  try {
    const verified = await compactVerify(proof.signature, keys, {
      algorithms: ['RS256'],
    });
    if (verified.protectedHeader.alg !== 'RS256' ||
      verified.protectedHeader.typ !== typ ||
      typeof verified.protectedHeader.kid !== 'string' ||
      !verified.protectedHeader.kid) hold(`${code}_SIGNATURE_INVALID`);
    signed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.payload));
  } catch {
    hold(`${code}_SIGNATURE_INVALID`);
  }
  const { signature: _signature, ...body } = proof;
  if (!isDeepStrictEqual(signed, body) ||
    proof.scope.billing_product !== scope.product ||
    proof.scope.organization_id !== scope.organisationId ||
    proof.scope.team_id !== scope.teamId ||
    proof.scope.billing_month !== scope.billingMonth ||
    ('pending_dispatch_count' in proof &&
      (proof.scope.exclude_dispatch_id !== scope.excludeDispatchId ||
        proof.scope.exclude_request_fingerprint !== scope.excludeRequestFingerprint
        || proof.scope.exclude_team_id !== scope.excludeTeamId
        || proof.scope.budget_scope_type !== scope.budgetScopeType
        || proof.scope.native_scope_type !== scope.nativeScopeType
        || proof.scope.native_scope_id !== scope.nativeScopeId
        || proof.scope.native_born_at !== scope.nativeBornAt
        || proof.scope.native_owner_sub !== scope.nativeOwnerSub))) {
    hold(`${code}_SCOPE_INVALID`);
  }
  if (proof.unresolved_paid_attempts !== '0') {
    hold(`${code}_UNRESOLVED`);
  }
  return proof;
}

export async function verifyLedgerPaidReceiptSet(
  value: unknown, scope: PaidReceiptScope, keys: KeyResolver = actorKeys(),
): Promise<LedgerPaidReceiptSet> {
  const parsed = receiptSetSchema.safeParse(value);
  if (!parsed.success) hold('LEDGER_PAID_RECEIPT_SET_INVALID');
  return verifySignedReceiptSet(parsed.data, scope, 'ledger-paid-receipt-set+jws',
    'LEDGER_PAID_RECEIPT_SET', keys);
}

export async function verifyLedgerBudgetReceiptSet(
  value: unknown, scope: BudgetReceiptScope, keys: KeyResolver = actorKeys(),
): Promise<LedgerBudgetReceiptSet> {
  const parsed = budgetReceiptSetSchema.safeParse(value);
  if (!parsed.success) hold('LEDGER_BUDGET_RECEIPT_SET_INVALID');
  return verifySignedReceiptSet(parsed.data, scope, 'ledger-budget-receipt-set+jws',
    'LEDGER_BUDGET_RECEIPT_SET', keys);
}

function binaryOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** A paid Ledger dispatch must have exactly one UOA-rated receipt, including
 * exact-zero paid receipts. Pre-cutover debit rows use their frozen reservation
 * raw cost; no raw metering aggregate or current tariff is substituted. */
export async function matchUoaPaidReceiptSet(reader: Reader,
  scope: PaidReceiptScope, proof: LedgerPaidReceiptSet,
): Promise<{ ratedMicrocredits: bigint; forwardMicrocredits: bigint;
  legacyMicrocredits: bigint; receiptCount: number; rawCostTotal: string }> {
  const where = { serviceId: scope.serviceId, orgId: scope.organisationId,
    teamId: scope.teamId, billingMonth: scope.billingMonth };
  const [forward, legacy] = await Promise.all([
    reader.billingPaidUsageLiability.findMany({ where, take: 100_001,
      select: { dispatchId: true, receiptId: true, rawCostActual: true,
        ratedMicrocredits: true } }),
    reader.billingCreditBudgetLegacyLiability.findMany({ where, take: 100_001,
      select: { dispatchId: true, receiptId: true, sourceId: true,
        sourceType: true, ratedMicrocredits: true } }),
  ]);
  if (forward.length + legacy.length > 100_000) hold('BILLING_CYCLE_RECEIPT_SET_TOO_LARGE');
  const reservations = await reader.billingPrepaidReservation.findMany({ where: {
    id: { in: legacy.map((row) => row.sourceId) },
  }, select: { id: true, dispatchId: true, receiptId: true, rawCostActual: true,
    debitedMicrocredits: true, status: true, serviceId: true, orgId: true,
    teamId: true, billingMonth: true } });
  const byReservation = new Map(reservations.map((row) => [row.id, row]));
  const rows = forward.map((row) => ({ dispatchId: row.dispatchId,
    receiptId: row.receiptId, rawCost: row.rawCostActual.toFixed(18) }));
  for (const row of legacy) {
    const reservation = byReservation.get(row.sourceId);
    if (row.sourceType !== 'prepaid_wallet_debit' || !reservation ||
      reservation.status !== 'SETTLED' ||
      reservation.dispatchId !== row.dispatchId ||
      reservation.receiptId !== row.receiptId ||
      reservation.serviceId !== scope.serviceId ||
      reservation.orgId !== scope.organisationId ||
      reservation.teamId !== scope.teamId ||
      reservation.billingMonth !== scope.billingMonth ||
      reservation.rawCostActual === null ||
      reservation.debitedMicrocredits !== row.ratedMicrocredits) {
      hold('BILLING_CYCLE_LEGACY_RECEIPT_INVALID');
    }
    rows.push({ dispatchId: row.dispatchId, receiptId: row.receiptId,
      rawCost: reservation.rawCostActual.toFixed(18) });
  }
  rows.sort((left, right) => binaryOrder(left.dispatchId, right.dispatchId));
  const digest = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || (index > 0 && row.dispatchId === rows[index - 1]?.dispatchId)) {
      hold('BILLING_CYCLE_RECEIPT_SET_DUPLICATE');
    }
    digest.update(JSON.stringify([row.dispatchId, row.receiptId, row.rawCost])).update('\n');
  }
  if (String(rows.length) !== proof.paid_receipt_count ||
    digest.digest('hex') !== proof.paid_receipt_sha256) {
    hold('BILLING_CYCLE_RECEIPT_SET_MISMATCH');
  }
  const forwardMicrocredits = forward.reduce((sum, row) => sum + row.ratedMicrocredits, 0n);
  const legacyMicrocredits = legacy.reduce((sum, row) => sum + row.ratedMicrocredits, 0n);
  const rawCostTotal = rows.reduce((sum, row) => sum.add(new Prisma.Decimal(row.rawCost)),
    new Prisma.Decimal(0)).toFixed(18);
  return { ratedMicrocredits: forwardMicrocredits + legacyMicrocredits,
    forwardMicrocredits, legacyMicrocredits, receiptCount: rows.length, rawCostTotal };
}

export async function fetchVerifiedLedgerPaidReceiptSet(
  scope: PaidReceiptScope,
  deps?: { fetchRaw?: typeof fetchLedgerRawPaidReceiptSet; keys?: KeyResolver },
): Promise<LedgerPaidReceiptSet> {
  const raw = await (deps?.fetchRaw ?? fetchLedgerRawPaidReceiptSet)(scope);
  return verifyLedgerPaidReceiptSet(raw, scope, deps?.keys);
}

/** Match every paid dispatch projected into one budget product namespace,
 * including descendants billed by another product. Legacy rows can match
 * only their frozen wallet debit; missing cross-product lineage stays held. */
export async function matchUoaBudgetReceiptSet(reader: Reader,
  scope: BudgetReceiptScope, proof: LedgerBudgetReceiptSet,
): Promise<{ ratedMicrocredits: bigint; receiptCount: number }> {
  const [year, month] = scope.billingMonth.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const scopes = await reader.billingCreditBudgetDispatchScope.findMany({ where: {
    product: scope.product, orgId: scope.organisationId,
    ...(scope.teamId ? { teamId: scope.teamId } : {}),
    scopeType: scope.nativeScopeType ?? (scope.budgetScopeType ?? 'team'),
    scopeId: scope.nativeScopeId ??
      (scope.budgetScopeType === 'organization' ? scope.organisationId : scope.teamId ?? ''),
    occurredAt: { gte: start, lt: end },
  }, take: 100_001, select: { dispatchId: true } });
  if (scopes.length > 100_000) hold('BUDGET_RECEIPT_SET_TOO_LARGE');
  const ids = scopes.map((row) => row.dispatchId);
  const [holds, forward, legacy] = await Promise.all([
    reader.billingCreditBudgetDispatch.findMany({ where: { dispatchId: { in: ids } },
      select: { dispatchId: true, status: true } }),
    reader.billingPaidUsageLiability.findMany({ where: { dispatchId: { in: ids } },
      select: { dispatchId: true, receiptId: true, rawCostActual: true,
        ratedMicrocredits: true } }),
    reader.billingCreditBudgetLegacyLiability.findMany({ where: { dispatchId: { in: ids } },
      select: { dispatchId: true, receiptId: true, sourceId: true,
        sourceType: true, ratedMicrocredits: true, teamId: true } }),
  ]);
  if (holds.length !== ids.length || forward.length + legacy.length > 100_000) {
    hold('BUDGET_RECEIPT_SET_COHORT_INVALID');
  }
  const receipts = new Set([...forward, ...legacy].map((row) => row.dispatchId));
  if (holds.some((row) => row.status === 'SETTLED' && !receipts.has(row.dispatchId))) {
    hold('BUDGET_RECEIPT_SET_UOA_UNRESOLVED');
  }
  const active = holds.filter((row) => row.status === 'ACTIVE')
    .map((row) => row.dispatchId).sort(binaryOrder);
  const pendingDigest = createHash('sha256')
    .update('ledger-budget-receipt-set-v1:pending\n');
  for (const dispatchId of active) {
    pendingDigest.update(JSON.stringify([dispatchId])).update('\n');
  }
  if (String(active.length) !== proof.pending_dispatch_count ||
    pendingDigest.digest('hex') !== proof.pending_dispatch_sha256) {
    hold('BUDGET_RECEIPT_SET_PENDING_MISMATCH');
  }
  const reservations = await reader.billingPrepaidReservation.findMany({ where: {
    id: { in: legacy.map((row) => row.sourceId) },
  }, select: { id: true, dispatchId: true, receiptId: true, rawCostActual: true,
    debitedMicrocredits: true, status: true, orgId: true, teamId: true,
    billingMonth: true } });
  const byReservation = new Map(reservations.map((row) => [row.id, row]));
  const rows = forward.map((row) => ({ dispatchId: row.dispatchId,
    receiptId: row.receiptId, rawCost: row.rawCostActual.toFixed(18) }));
  for (const row of legacy) {
    const reservation = byReservation.get(row.sourceId);
    if (row.sourceType !== 'prepaid_wallet_debit' || !reservation ||
      reservation.status !== 'SETTLED' ||
      reservation.dispatchId !== row.dispatchId || reservation.receiptId !== row.receiptId ||
      reservation.orgId !== scope.organisationId || reservation.teamId !== row.teamId ||
      (scope.teamId !== null && reservation.teamId !== scope.teamId) ||
      reservation.billingMonth !== scope.billingMonth || !reservation.rawCostActual ||
      reservation.debitedMicrocredits !== row.ratedMicrocredits) {
      hold('BUDGET_RECEIPT_SET_LEGACY_INVALID');
    }
    rows.push({ dispatchId: row.dispatchId, receiptId: row.receiptId,
      rawCost: reservation.rawCostActual.toFixed(18) });
  }
  rows.sort((left, right) => binaryOrder(left.dispatchId, right.dispatchId));
  const digest = createHash('sha256').update('ledger-budget-receipt-set-v1:paid\n');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || (index > 0 && row.dispatchId === rows[index - 1]?.dispatchId)) {
      hold('BUDGET_RECEIPT_SET_DUPLICATE');
    }
    digest.update(JSON.stringify([row.dispatchId, row.receiptId, row.rawCost])).update('\n');
  }
  if (String(rows.length) !== proof.paid_receipt_count ||
    digest.digest('hex') !== proof.paid_receipt_sha256) {
    hold('BUDGET_RECEIPT_SET_MISMATCH');
  }
  return { ratedMicrocredits: forward.reduce((sum, row) => sum + row.ratedMicrocredits, 0n) +
    legacy.reduce((sum, row) => sum + row.ratedMicrocredits, 0n), receiptCount: rows.length };
}

export async function fetchVerifiedLedgerBudgetReceiptSet(
  scope: BudgetReceiptScope,
  deps?: { fetchRaw?: typeof fetchLedgerRawBudgetReceiptSet; keys?: KeyResolver },
): Promise<LedgerBudgetReceiptSet> {
  const raw = await (deps?.fetchRaw ?? fetchLedgerRawBudgetReceiptSet)(scope);
  return verifyLedgerBudgetReceiptSet(raw, scope, deps?.keys);
}
