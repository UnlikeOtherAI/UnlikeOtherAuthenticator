import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Prisma, type PrismaClient } from '@prisma/client';
import { compactVerify, createLocalJWKSet, createRemoteJWKSet } from 'jose';
import { z } from 'zod';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { fetchLedgerRawPaidReceiptSet } from './billing-ledger-collector.service.js';

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

export type LedgerPaidReceiptSet = z.infer<typeof receiptSetSchema>;
export type PaidReceiptScope = { product: string; organisationId: string;
  teamId: string; billingMonth: string; serviceId: string };

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

export async function verifyLedgerPaidReceiptSet(
  value: unknown, scope: PaidReceiptScope, keys: KeyResolver = actorKeys(),
): Promise<LedgerPaidReceiptSet> {
  const parsed = receiptSetSchema.safeParse(value);
  if (!parsed.success) hold('LEDGER_PAID_RECEIPT_SET_INVALID');
  const proof = parsed.data;
  let signed: unknown;
  try {
    const verified = await compactVerify(proof.signature, keys, {
      algorithms: ['RS256'],
    });
    if (verified.protectedHeader.alg !== 'RS256' ||
      verified.protectedHeader.typ !== 'ledger-paid-receipt-set+jws' ||
      typeof verified.protectedHeader.kid !== 'string' ||
      !verified.protectedHeader.kid) hold('LEDGER_PAID_RECEIPT_SET_SIGNATURE_INVALID');
    signed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.payload));
  } catch {
    hold('LEDGER_PAID_RECEIPT_SET_SIGNATURE_INVALID');
  }
  const { signature: _signature, ...body } = proof;
  if (!isDeepStrictEqual(signed, body) ||
    proof.scope.billing_product !== scope.product ||
    proof.scope.organization_id !== scope.organisationId ||
    proof.scope.team_id !== scope.teamId ||
    proof.scope.billing_month !== scope.billingMonth) {
    hold('LEDGER_PAID_RECEIPT_SET_SCOPE_INVALID');
  }
  if (proof.unresolved_paid_attempts !== '0') {
    hold('LEDGER_PAID_RECEIPT_SET_UNRESOLVED');
  }
  return proof;
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
