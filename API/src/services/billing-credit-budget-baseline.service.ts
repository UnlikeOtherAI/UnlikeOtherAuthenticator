import { createHash } from 'node:crypto';
import { type Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { attachLegacyBudgetDispatch } from './billing-credit-budget-dispatch.service.js';
import { fetchVerifiedLedgerBudgetReceiptSet, matchUoaBudgetReceiptSet } from
  './billing-ledger-paid-receipt-proof.service.js';
import { recordLegacyPrepaidLiability } from './billing-paid-liability.service.js';

type Scope = { product: string; orgId: string; teamId: string;
  scopeType: string; scopeId: string };
const MAX_LEGACY_RESERVATIONS = 100_000;

/** Reuse an exact signed cohort only within one financial decision. A later
 * decision fetches a fresh proof, including after a serializable retry. */
export function memoizedBudgetProof(
  fetchProof: typeof fetchVerifiedLedgerBudgetReceiptSet =
    fetchVerifiedLedgerBudgetReceiptSet,
): typeof fetchVerifiedLedgerBudgetReceiptSet {
  const proofs = new Map<string, ReturnType<typeof fetchVerifiedLedgerBudgetReceiptSet>>();
  return (scope) => {
    const key = JSON.stringify(scope);
    let proof = proofs.get(key);
    if (!proof) {
      proof = fetchProof(scope);
      proofs.set(key, proof);
    }
    return proof;
  };
}

function monthAt(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function backfillFrozenPrepaid(tx: Prisma.TransactionClient, scope: Scope,
  teamId: string | null, month: string) {
  const service = await tx.billingService.findUnique({ where: { identifier: scope.product },
    select: { id: true } });
  if (!service) throw new AppError('INTERNAL', 409, 'BUDGET_BASELINE_SERVICE_UNKNOWN');
  const reservations = await tx.billingPrepaidReservation.findMany({ where: {
    serviceId: service.id, orgId: scope.orgId,
    ...(teamId ? { teamId } : {}), billingMonth: month,
    status: 'SETTLED',
  }, include: { tariff: { select: { mode: true, markupBps: true } } },
  orderBy: [{ dispatchStartedAt: 'asc' }, { id: 'asc' }],
  take: MAX_LEGACY_RESERVATIONS + 1 });
  if (reservations.length > MAX_LEGACY_RESERVATIONS) {
    throw new AppError('INTERNAL', 409, 'BUDGET_BASELINE_TOO_LARGE');
  }
  for (const reservation of reservations) {
    const existing = await tx.billingCreditBudgetDispatch.findUnique({
      where: { dispatchId: reservation.dispatchId }, select: { isLegacy: true },
    });
    if (existing && !existing.isLegacy) continue;
    if (!reservation.receiptId || reservation.rawCostActual === null ||
      reservation.debitedMicrocredits === null ||
      reservation.dispatchStartedAt.toISOString().slice(0, 7) !== month) {
      throw new AppError('INTERNAL', 409, 'BUDGET_BASELINE_FROZEN_DEBIT_MISSING');
    }
    await attachLegacyBudgetDispatch(tx, {
      dispatchId: reservation.dispatchId, startedAt: reservation.dispatchStartedAt,
      product: scope.product, serviceId: reservation.serviceId,
      providerServiceId: reservation.providerServiceId,
      orgId: reservation.orgId, teamId: reservation.teamId, userId: reservation.userId,
      billingMonth: reservation.billingMonth, currency: reservation.currency,
      tariffId: reservation.tariffId, tariffMode: reservation.tariff.mode,
      markupBps: reservation.tariff.markupBps, paymentMode: 'PREPAID',
      reservedMicrocredits: reservation.reservedMicrocredits,
    });
    await recordLegacyPrepaidLiability(tx, { dispatchId: reservation.dispatchId,
      receiptId: reservation.receiptId, reservationId: reservation.id,
      ratedMicrocredits: reservation.debitedMicrocredits,
      occurredAt: reservation.dispatchStartedAt });
  }
}

/** Every month in the decision window is matched to a fresh signed Ledger
 * cohort. Frozen old-path reservations are identified by their durable source
 * and absent forward hold, never by a migration timestamp. */
export async function proveHistoricalBudgetScope(tx: Prisma.TransactionClient,
  scope: Scope, start: Date, end: Date | null,
  deps?: { fetchProof?: typeof fetchVerifiedLedgerBudgetReceiptSet;
    excludeDispatchId?: string; excludeRequestFingerprint?: string;
    excludedAt?: Date }): Promise<boolean> {
  const native = scope.scopeType === 'project' || scope.scopeType === 'run'
    ? await tx.billingCreditBudgetNativeScope.findUnique({ where: {
      product_orgId_scopeType_scopeId: { product: scope.product, orgId: scope.orgId,
        scopeType: scope.scopeType, scopeId: scope.scopeId },
    } }) : null;
  if ((scope.scopeType === 'project' || scope.scopeType === 'run')
    && (!native || native.teamId !== scope.teamId
      || (scope.scopeType === 'run' && !native.ownerUserId))) return false;
  const teams: Array<string | null> = scope.scopeType === 'organization'
    ? [null] : [scope.teamId];
  const stop = end ?? new Date();
  if (native && native.sourceCreatedAt >= stop) return true;
  const earliest = native && native.sourceCreatedAt > start ? native.sourceCreatedAt : start;
  const month = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), 1));
  let monthCount = 0;
  for (; month < stop; month.setUTCMonth(month.getUTCMonth() + 1)) {
    monthCount += 1;
    if (monthCount > 12) return false;
    for (const teamId of teams) {
      const proofScope = { product: scope.product, organisationId: scope.orgId,
        teamId, billingMonth: monthAt(month),
        ...(scope.scopeType === 'organization'
          ? { budgetScopeType: 'organization' as const } : {}),
        ...(native ? { nativeScopeType: native.scopeType as 'project' | 'run',
          nativeScopeId: native.scopeId,
          nativeBornAt: native.sourceCreatedAt.toISOString(),
          ...(native.ownerUserId ? { nativeOwnerSub: native.ownerUserId } : {}) } : {}),
        ...(deps?.excludeDispatchId && deps.excludedAt &&
          (teamId === null || teamId === scope.teamId)
          && monthAt(month) === monthAt(deps.excludedAt)
          ? { excludeDispatchId: deps.excludeDispatchId,
            excludeRequestFingerprint: deps.excludeRequestFingerprint,
            excludeTeamId: scope.teamId } : {}) };
      let proof;
      try {
        proof = await (deps?.fetchProof ?? fetchVerifiedLedgerBudgetReceiptSet)(proofScope);
      } catch {
        return false;
      }
      try {
        if (!native) await backfillFrozenPrepaid(tx, scope, teamId,
          proofScope.billingMonth);
        await matchUoaBudgetReceiptSet(tx, proofScope, proof);
        const audit = {
          product: proofScope.product, orgId: proofScope.organisationId,
          teamId: proofScope.teamId, billingMonth: proofScope.billingMonth,
          budgetScopeType: proofScope.budgetScopeType ?? null,
          excludedDispatchId: proofScope.excludeDispatchId ?? null,
          excludedTeamId: proofScope.excludeTeamId ?? null,
          nativeScopeType: proofScope.nativeScopeType ?? null,
          nativeScopeId: proofScope.nativeScopeId ?? null,
          nativeBornAt: proofScope.nativeBornAt
            ? new Date(proofScope.nativeBornAt) : null,
          nativeOwnerSub: proofScope.nativeOwnerSub ?? null,
          ledgerCursor: proof.snapshot.cursor,
          signatureSha256: createHash('sha256').update(proof.signature).digest('hex'),
          capturedAt: new Date(proof.snapshot.captured_at),
          paidReceiptCount: Number(proof.paid_receipt_count),
          paidReceiptSha256: proof.paid_receipt_sha256,
          zeroIncrementalCount: Number(proof.zero_incremental_count),
          zeroIncrementalSha256: proof.zero_incremental_sha256,
          pendingDispatchCount: Number(proof.pending_dispatch_count),
          pendingDispatchSha256: proof.pending_dispatch_sha256,
        };
        await tx.billingCreditBudgetReceiptProofAudit.createMany({
          data: [audit], skipDuplicates: true,
        });
        const stored = await tx.billingCreditBudgetReceiptProofAudit.findUniqueOrThrow({
          where: { ledgerCursor: audit.ledgerCursor },
        });
        if (stored.signatureSha256 !== audit.signatureSha256
          || stored.product !== audit.product || stored.orgId !== audit.orgId
          || stored.teamId !== audit.teamId || stored.billingMonth !== audit.billingMonth
          || stored.budgetScopeType !== audit.budgetScopeType
          || stored.excludedDispatchId !== audit.excludedDispatchId
          || stored.excludedTeamId !== audit.excludedTeamId
          || stored.nativeScopeType !== audit.nativeScopeType
          || stored.nativeScopeId !== audit.nativeScopeId
          || stored.nativeBornAt?.getTime() !== audit.nativeBornAt?.getTime()
          || stored.nativeOwnerSub !== audit.nativeOwnerSub) {
          throw new AppError('INTERNAL', 409, 'BUDGET_PROOF_CURSOR_CONFLICT');
        }
      } catch (error) {
        if (error instanceof AppError) return false;
        throw error;
      }
    }
  }
  return true;
}
