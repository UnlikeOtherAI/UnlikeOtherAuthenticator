import { Prisma } from '@prisma/client';
import type { BillingVoiceReceiptRequestV1, BillingVoiceReservationV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { VoiceDependencies } from './billing-voice-quote.service.js';
import { voiceRow } from './billing-voice-dispatch.service.js';
import { publicVoiceReservation } from './billing-voice-reservation.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { recordPaidUsageLiability } from './billing-paid-liability.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';

export async function settleVoice(input: { request: BillingVoiceReceiptRequestV1; credential: VerifiedBillingAppKey },
  deps: Pick<VoiceDependencies, 'prisma' | 'voice'>): Promise<BillingVoiceReservationV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const observed = await prisma.billingVoiceReservation.findUnique({ where: { dispatchId: input.request.dispatch_id } });
  if (!observed || observed.serviceId !== input.credential.service.id ||
      observed.requestFingerprint !== input.request.request_fingerprint) throw new AppError('NOT_FOUND', 404);
  const receipt = await deps.voice.receipt({ accountSid: observed.accountSid, from: observed.from, to: observed.to,
    direction: observed.direction as 'inbound' | 'outbound' }, input.request.call_sid);
  return runBillingSerializableTransaction(prisma, async tx => {
    const row = await voiceRow(tx, input.request, input.credential, input.request.request_fingerprint);
    if ((row.callSid && row.callSid !== input.request.call_sid) || row.state === 'released' ||
        (!row.dispatchClaimedAt && row.direction !== 'inbound')) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_RECEIPT_CONFLICT');
    const parent = row.parentReservationId ? await tx.billingVoiceReservation.findUnique({ where: { id: row.parentReservationId } }) : null;
    if (receipt.parentCallSid !== (parent?.callSid ?? null) ||
        (receipt.startedAt && row.dispatchClaimedAt && receipt.startedAt.getTime() < row.dispatchClaimedAt.getTime() - 1000)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_RECEIPT_CONFLICT');
    }
    if (row.state === 'settled') {
      if (receipt.amount === null || !row.actualAmount?.eq(receipt.amount) || receipt.currency !== 'USD' ||
          receipt.seconds !== row.actualDurationSeconds) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_RECEIPT_CHANGED');
      return publicVoiceReservation(row);
    }
    if (!receipt.terminal || receipt.amount === null || receipt.currency === null || receipt.seconds === null) {
      return publicVoiceReservation(await tx.billingVoiceReservation.update({ where: { id: row.id }, data: {
        callSid: input.request.call_sid, state: receipt.terminal ? 'uncertain' : row.state,
      } }));
    }
    const quote = await tx.billingVoiceQuote.findUniqueOrThrow({ where: { id: row.quoteId } });
    const actual = new Prisma.Decimal(receipt.amount);
    if (receipt.currency !== 'USD' || receipt.seconds > row.maxDurationSeconds || actual.greaterThan(quote.rawCostBound) ||
        (!row.dispatchClaimedAt && actual.greaterThan(0))) {
      return publicVoiceReservation(await tx.billingVoiceReservation.update({ where: { id: row.id }, data: {
        callSid: input.request.call_sid, state: 'reconciliation', actualAmount: actual, actualDurationSeconds: receipt.seconds,
      } }));
    }
    const balance = await lockCreditBalance(tx, row.creditAccountId);
    const liability = await recordPaidUsageLiability(tx, { dispatchId: row.dispatchId,
      receiptId: input.request.call_sid, actual, creditAccountId: row.creditAccountId });
    const debit = liability.ratedMicrocredits;
    if (debit > row.reservedMicrocredits || debit > balance) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_RECEIPT_EXCEEDS_HOLD');
    const settled = await tx.billingVoiceReservation.update({ where: { id: row.id }, data: {
      state: 'settled', debitedMicrocredits: debit, actualAmount: actual,
      actualDurationSeconds: receipt.seconds, callSid: input.request.call_sid,
    } });
    if (debit > 0n) await tx.billingCreditEntry.create({ data: {
      creditAccountId: row.creditAccountId, serviceId: row.serviceId, appKeyId: input.credential.id,
      attributedUserId: row.userId, kind: 'VOICE_PREPAID_USAGE', direction: 'DEBIT',
      amountMicrocredits: debit, balanceAfterMicrocredits: balance - debit, currency: 'USD', occurredAt: row.createdAt,
      sourceType: 'voice_provider_receipt', sourceId: row.id, voiceReservationId: row.id,
      idempotencyKey: `voice-receipt:${row.accountSid}:${input.request.call_sid}`,
    } });
    return publicVoiceReservation(settled);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED', { timeoutMs: 30000 });
}
