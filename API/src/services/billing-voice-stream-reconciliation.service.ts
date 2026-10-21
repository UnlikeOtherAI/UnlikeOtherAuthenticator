import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingVoiceStreamReconciliationRequestV1, BillingVoiceStreamReconciliationV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockTelephoneCredential } from './billing-telephone-authority.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';

/** Account-level operator evidence is never assigned to a customer or used to change their fixed debit. */
export async function reconcileVoiceStreams(input: { request: BillingVoiceStreamReconciliationRequestV1;
  credential: VerifiedBillingAppKey }, deps?: { prisma?: PrismaClient }): Promise<BillingVoiceStreamReconciliationV1> {
  const body = input.request; const credential = input.credential;
  if (credential.purpose !== 'VOICE_RUNTIME' || body.product !== credential.service.identifier) throw new AppError('FORBIDDEN', 403);
  return runBillingSerializableTransaction(deps?.prisma ?? getAdminPrisma(), async tx => {
    await lockTelephoneCredential(tx, credential);
    const owns = await tx.billingSmsNumberResource.findFirst({ where: { accountSid: body.account_sid, serviceId: credential.service.id } });
    if (!owns) throw new AppError('NOT_FOUND', 404);
    // Never label a partial multi-product account total as an exact invoice reconciliation.
    if (await tx.billingSmsNumberResource.findFirst({ where: { accountSid: body.account_sid, serviceId: { not: credential.service.id } } })) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_INVOICE_ACCOUNT_SHARED');
    }
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`voice-invoice:${credential.service.id}:${body.account_sid}:${body.billing_month}`},0))::text`);
    if (body.invoice) {
      const prior = await tx.billingVoiceStreamInvoice.findUnique({ where: { id: body.invoice.id } });
      if (prior) {
        if (prior.serviceId !== credential.service.id || prior.accountSid !== body.account_sid || prior.billingMonth !== body.billing_month
          || !prior.amount.eq(body.invoice.amount_usd) || prior.reference !== body.invoice.reference) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_INVOICE_CHANGED');
        }
      } else await tx.billingVoiceStreamInvoice.create({ data: { id: body.invoice.id, serviceId: credential.service.id,
        accountSid: body.account_sid, billingMonth: body.billing_month, amount: body.invoice.amount_usd, reference: body.invoice.reference } });
    }
    const from = new Date(`${body.billing_month}-01T00:00:00.000Z`);
    const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1);
    const scope = { serviceId: credential.service.id, accountSid: body.account_sid, startedAt: { gte: from, lt: to } };
    const sum = await tx.billingVoiceStream.aggregate({ where: scope, _sum: { fixedAmount: true } });
    const fixed = sum._sum.fixedAmount ?? new Prisma.Decimal(0);
    const invoice = await tx.billingVoiceStreamInvoice.findFirst({ where: { serviceId: credential.service.id,
      accountSid: body.account_sid, billingMonth: body.billing_month }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    // Include admitted calls with no start record, not just known streams with no stop.
    const pending = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*) FROM billing_voice_reservations r JOIN billing_voice_quotes q ON q.id=r.quote_id
      LEFT JOIN billing_voice_streams s ON s.reservation_id=r.id
      WHERE r.service_id=${credential.service.id} AND r.account_sid=${body.account_sid} AND q.stream_enabled
        AND r.dispatch_claimed_at IS NOT NULL AND r.state <> 'released'
        AND (s.started_at >= ${from} AND s.started_at < ${to} OR s.id IS NULL AND r.created_at >= ${from} AND r.created_at < ${to})
        AND (s.stopped_at IS NULL OR r.state <> 'settled')`);
    const pendingCount = Number(pending[0]?.count ?? 0);
    const difference = invoice ? fixed.minus(invoice.amount) : null;
    return { account_sid: body.account_sid, billing_month: body.billing_month, fixed_stream_amount_usd: fixed.toString(),
      pending_streams: pendingCount, invoice_amount_usd: invoice?.amount.toString() ?? null,
      invoice_reference: invoice?.reference ?? null, difference_usd: difference?.toString() ?? null,
      status: pendingCount ? 'pending_calls' : !invoice ? 'awaiting_invoice' : difference?.isZero() ? 'matched' : 'difference',
      invoice_source: 'operator_reported' };
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}
