import { Prisma, type BillingSmsInboundReceipt } from '@prisma/client';
import type { BillingSmsInboundReceiptRequestV1, BillingSmsInboundReceiptV1 } from
  '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockSmsCredential } from './billing-sms-authority.service.js';
import type { SmsNumberDependencies } from './billing-sms-number.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { smsMicrocredits, smsProviderUsd, multiplySmsAmount } from './billing-sms-money.service.js';
import { maximumRatedMicrocredits, recordPaidUsageLiability } from './billing-paid-liability.service.js';
import { reserveBudgetDispatch } from './billing-credit-budget-dispatch.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';

function publicInbound(row: BillingSmsInboundReceipt): BillingSmsInboundReceiptV1 {
  return { message_sid: row.messageSid, state: row.state as BillingSmsInboundReceiptV1['state'],
    consumed_credits: row.consumedMicrocredits === null ? null : smsMicrocredits(row.consumedMicrocredits),
    uncollected_credits: row.uncollectedMicrocredits === null ? null : smsMicrocredits(row.uncollectedMicrocredits) };
}

/** Received messages survive insufficient funds; uncovered liability never creates a wallet debit. */
export async function settleSmsInbound(input: { request: BillingSmsInboundReceiptRequestV1;
  credential: VerifiedBillingAppKey }, deps: Pick<SmsNumberDependencies, 'prisma' | 'provider'>): Promise<BillingSmsInboundReceiptV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const body = input.request;
  const number = await prisma.billingSmsNumberResource.findUnique({ where: { id: body.number_id } });
  if (!number || number.serviceId !== input.credential.service.id || number.orgId !== body.organisation_id ||
      body.product !== input.credential.service.identifier || !number.accountSid) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_INBOUND_BINDING_CONFLICT');
  }
  const accountSid = number.accountSid;
  const evidence = await deps.provider.inboundMessage(accountSid, body.message_sid, number.phoneNumber);
  if (evidence.createdAt.getTime() < Math.floor(number.createdAt.getTime() / 1000) * 1000) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_INBOUND_PREDATES_RESOURCE');
  }
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sms-inbound:${number.id}:${body.allocation_id}`}, 0))::text`);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sms-message:${number.accountSid}:${body.message_sid}`}, 0))::text`);
    const original = await tx.billingSmsInboundReceipt.findUnique({ where: { accountSid_messageSid: {
      accountSid, messageSid: body.message_sid,
    } } });
    if (original && (original.serviceId !== input.credential.service.id || original.numberId !== number.id ||
        original.allocationId !== body.allocation_id || original.orgId !== body.organisation_id || original.teamId !== body.team_id)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_INBOUND_BINDING_CONFLICT');
    }
    if (original && ['funded', 'uncollected'].includes(original.state)) {
      if (evidence.receipt.amount === null || evidence.receipt.currency !== original.actualCurrency ||
          !original.actualAmount?.eq(evidence.receipt.amount)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RECEIPT_CHANGED');
      }
      return publicInbound(original);
    }
    const hold = await tx.billingSmsStandingHold.findUnique({ where: { serviceId_numberId_allocationId: {
      serviceId: input.credential.service.id, numberId: number.id, allocationId: body.allocation_id,
    } } });
    if (hold && (hold.orgId !== body.organisation_id || hold.teamId !== body.team_id)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_INBOUND_BINDING_CONFLICT');
    }
    if (!hold) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id = ${body.organisation_id} FOR SHARE`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM teams WHERE id = ${body.team_id} FOR SHARE`);
      const team = await tx.team.findFirst({ where: { id: body.team_id, orgId: body.organisation_id,
        lifecycleStatus: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE' } }, select: { id: true } });
      if (!team) throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_INBOUND_HIERARCHY_NOT_ACTIVE');
    }
    let row = original ?? await tx.billingSmsInboundReceipt.create({ data: {
      serviceId: input.credential.service.id, numberId: number.id, allocationId: body.allocation_id,
      accountSid, messageSid: body.message_sid, orgId: body.organisation_id,
      teamId: body.team_id, standingHoldId: hold?.id,
    } });
    const receipt = evidence.receipt;
    if (!receipt.terminal || receipt.amount === null || receipt.currency === null) return publicInbound(row);
    // Twilio creation timestamps have second precision. A cutover inside that second is ambiguous.
    if (hold?.retiredAt && evidence.createdAt.getTime() + 1000 > hold.retiredAt.getTime()) {
      return publicInbound(await tx.billingSmsInboundReceipt.update({ where: { id: row.id }, data: { state: 'reconciliation' } }));
    }
    const funding = hold ? await tx.billingSmsStandingFunding.findFirst({ where: {
      holdId: hold.id, createdAt: { lte: evidence.createdAt },
    }, orderBy: { createdAt: 'desc' } }) : null;
    const quote = funding ? await tx.billingSmsQuote.findUnique({ where: { id: funding.quoteId } }) : null;
    const fx = quote ? await tx.billingSmsFxSnapshot.findUnique({ where: { id: quote.fxSnapshotId } }) :
      await tx.billingSmsFxSnapshot.findFirst({ where: { acceptedAt: { lte: evidence.createdAt },
        expiresAt: { gt: evidence.createdAt } }, orderBy: { acceptedAt: 'desc' } });
    if (!fx || (quote && receipt.currency !== quote.providerCurrency)) {
      return publicInbound(await tx.billingSmsInboundReceipt.update({ where: { id: row.id }, data: { state: 'reconciliation' } }));
    }
    if (!quote) {
      return publicInbound(await tx.billingSmsInboundReceipt.update({ where: { id: row.id }, data: {
        state: 'uncollected', actualAmount: receipt.amount, actualCurrency: receipt.currency,
      } }));
    }
    const actual = smsProviderUsd(receipt.amount, receipt.currency, fx.usdPerEur.toFixed());
    const maximum = maximumRatedMicrocredits(actual, quote.messageMarkupBps);
    const charge = { actualAmount: receipt.amount, actualCurrency: receipt.currency, quoteId: quote?.id ?? null };
    if (quote && (receipt.segments === null || receipt.segments < 1 || receipt.segments > 100 ||
        !quote.providerBoundAmount || maximum > maximumRatedMicrocredits(multiplySmsAmount(
          smsProviderUsd(quote.providerBoundAmount.toFixed(), quote.providerCurrency, fx.usdPerEur.toFixed()).toFixed(),
          receipt.segments), quote.messageMarkupBps))) {
      return publicInbound(await tx.billingSmsInboundReceipt.update({ where: { id: row.id }, data: {
        ...charge, state: 'reconciliation', uncollectedMicrocredits: maximum,
      } }));
    }
    if (!hold || !funding || hold.state === 'reconciliation' || maximum > hold.reservedMicrocredits) {
      return publicInbound(await tx.billingSmsInboundReceipt.update({ where: { id: row.id }, data: {
        ...charge, state: 'uncollected', uncollectedMicrocredits: maximum,
      } }));
    }
    const dispatchId = `sms-inbound:${number.accountSid}:${body.message_sid}`;
    await tx.$executeRawUnsafe('SAVEPOINT sms_inbound_budget');
    try {
      await reserveBudgetDispatch(tx, { dispatchId, requestFingerprint: row.id, startedAt: evidence.createdAt,
      product: body.product, serviceId: input.credential.service.id, providerServiceId: 'twilio-sms',
      orgId: hold.orgId, teamId: hold.teamId, userId: hold.requestedByUserId,
      billingMonth: evidence.createdAt.toISOString().slice(0, 7), currency: 'USD',
      tariffId: `sms-quote:${quote.id}`, tariffMode: 'STANDARD', markupBps: quote.messageMarkupBps,
        paymentMode: 'PREPAID', rawCostBound: actual, context: null });
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT sms_inbound_budget');
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sms_inbound_budget');
      if (!(error instanceof AppError) || ![402, 403].includes(error.statusCode)) throw error;
      return publicInbound(await tx.billingSmsInboundReceipt.update({ where: { id: row.id }, data: {
        ...charge, state: 'uncollected', uncollectedMicrocredits: maximum,
      } }));
    }
    const balance = await lockCreditBalance(tx, hold.creditAccountId);
    const liability = await recordPaidUsageLiability(tx, { dispatchId, receiptId: body.message_sid,
      actual, creditAccountId: hold.creditAccountId });
    const debit = liability.ratedMicrocredits;
    if (debit > hold.reservedMicrocredits || debit > balance) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RECEIPT_EXCEEDS_HOLD');
    await tx.billingSmsStandingHold.update({ where: { id: hold.id }, data: { reservedMicrocredits: hold.reservedMicrocredits - debit } });
    row = await tx.billingSmsInboundReceipt.update({ where: { id: row.id }, data: {
      ...charge, state: 'funded', consumedMicrocredits: debit,
    } });
    if (debit > 0n) await tx.billingCreditEntry.create({ data: {
      creditAccountId: hold.creditAccountId, serviceId: hold.serviceId, appKeyId: input.credential.id,
      attributedUserId: hold.requestedByUserId, kind: 'SMS_PREPAID_USAGE', direction: 'DEBIT',
      amountMicrocredits: debit, balanceAfterMicrocredits: balance - debit, currency: 'USD',
      occurredAt: evidence.createdAt,
      sourceType: 'sms_inbound_receipt', sourceId: row.id, smsInboundReceiptId: row.id,
      idempotencyKey: `sms-inbound:${number.accountSid}:${body.message_sid}`,
    } });
    return publicInbound(row);
  }, 'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED', { timeoutMs: 30_000 });
}
