import { Prisma } from '@prisma/client';
import type { BillingSmsReceiptRequestV1, BillingSmsReservationV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockSmsCredential } from './billing-sms-authority.service.js';
import { publicSmsReservation } from './billing-sms-reservation.service.js';
import { multiplySmsAmount, smsProviderUsd } from './billing-sms-money.service.js';
import type { SmsNumberDependencies } from './billing-sms-number.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { maximumRatedMicrocredits, recordPaidUsageLiability } from './billing-paid-liability.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';

export async function settleSmsReceipt(input: { request: BillingSmsReceiptRequestV1;
  credential: VerifiedBillingAppKey }, deps: Pick<SmsNumberDependencies, 'prisma' | 'provider'>): Promise<BillingSmsReservationV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const observed = await prisma.billingSmsReservation.findUnique({ where: { dispatchId: input.request.dispatch_id } });
  if (!observed || observed.serviceId !== input.credential.service.id ||
      input.request.product !== input.credential.service.identifier ||
      observed.requestFingerprint !== input.request.request_fingerprint ||
      !observed.dispatchClaimedAt || (observed.messageSid && observed.messageSid !== input.request.message_sid)) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RECEIPT_BINDING_CONFLICT');
  }
  const receipt = await deps.provider.receipt({ accountSid: observed.accountSid,
    messageSid: input.request.message_sid, from: observed.from, to: observed.to, direction: 'outbound',
    notBefore: observed.dispatchClaimedAt });
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.request.dispatch_id}, 0))::text`);
    const row = await tx.billingSmsReservation.findUniqueOrThrow({ where: { dispatchId: input.request.dispatch_id } });
    if (row.serviceId !== input.credential.service.id || row.requestFingerprint !== input.request.request_fingerprint ||
        (row.messageSid && row.messageSid !== input.request.message_sid) || ['reserved', 'released'].includes(row.state)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RECEIPT_BINDING_CONFLICT');
    }
    if (row.state === 'settled') {
      if (receipt.amount === null || receipt.currency !== row.actualCurrency ||
          !row.actualAmount?.eq(receipt.amount)) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RECEIPT_CHANGED');
      return publicSmsReservation(row);
    }
    if (!receipt.terminal || receipt.amount === null || receipt.currency === null || receipt.segments === null) {
      return publicSmsReservation(await tx.billingSmsReservation.update({ where: { id: row.id },
        data: { state: 'uncertain', messageSid: input.request.message_sid } }));
    }
    const quote = await tx.billingSmsQuote.findUniqueOrThrow({ where: { id: row.quoteId } });
    const fx = await tx.billingSmsFxSnapshot.findUniqueOrThrow({ where: { id: quote.fxSnapshotId } });
    if (receipt.currency !== quote.providerCurrency || receipt.segments < 1 || receipt.segments > row.maxSegments ||
        !quote.providerBoundAmount) {
      return publicSmsReservation(await tx.billingSmsReservation.update({ where: { id: row.id },
        data: { state: 'reconciliation', messageSid: input.request.message_sid } }));
    }
    const actual = smsProviderUsd(receipt.amount, receipt.currency, fx.usdPerEur.toFixed());
    const segmentBound = smsProviderUsd(multiplySmsAmount(quote.providerBoundAmount.toFixed(), receipt.segments).toFixed(),
      quote.providerCurrency, fx.usdPerEur.toFixed());
    if (actual.greaterThan(segmentBound) || maximumRatedMicrocredits(actual, quote.messageMarkupBps) > row.reservedMicrocredits) {
      return publicSmsReservation(await tx.billingSmsReservation.update({ where: { id: row.id }, data: {
        state: 'reconciliation', messageSid: input.request.message_sid,
        actualAmount: receipt.amount, actualCurrency: receipt.currency,
      } }));
    }
    const balance = await lockCreditBalance(tx, row.creditAccountId);
    const liability = await recordPaidUsageLiability(tx, { dispatchId: row.dispatchId,
      receiptId: input.request.message_sid, actual, creditAccountId: row.creditAccountId });
    const debit = liability.ratedMicrocredits;
    if (debit > row.reservedMicrocredits || debit > balance) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RECEIPT_EXCEEDS_HOLD');
    const settled = await tx.billingSmsReservation.update({ where: { id: row.id }, data: {
      state: 'settled', debitedMicrocredits: debit, actualAmount: receipt.amount,
      actualCurrency: receipt.currency, messageSid: input.request.message_sid,
    } });
    if (debit > 0n) await tx.billingCreditEntry.create({ data: {
      creditAccountId: row.creditAccountId, serviceId: row.serviceId, appKeyId: input.credential.id,
      attributedUserId: row.userId, kind: 'SMS_PREPAID_USAGE', direction: 'DEBIT',
      amountMicrocredits: debit, balanceAfterMicrocredits: balance - debit, currency: 'USD',
      occurredAt: row.createdAt,
      sourceType: 'sms_provider_receipt', sourceId: row.id, smsReservationId: row.id,
      idempotencyKey: `sms-receipt:${row.accountSid}:${input.request.message_sid}`,
    } });
    return publicSmsReservation(settled);
  }, 'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED', { timeoutMs: 30_000 });
}
