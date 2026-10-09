import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

const states = ['ending', 'recovery_required', 'refund_required'];
export async function listSmsRecoveryResources(cursor?: string) {
  const db = getAdminPrisma();
  const rows = await db.billingSmsNumberResource.findMany({
    where: { state: { in: states } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: 101,
    select: { id: true, serviceId: true, orgId: true, phoneNumber: true, country: true,
      state: true, recoveryReason: true, createdAt: true, updatedAt: true },
  });
  return { resources: rows.slice(0, 100).map((row) => ({ id: row.id,
    service_id: row.serviceId, organisation_id: row.orgId, phone_number: row.phoneNumber,
    country: row.country, state: row.state, recovery_reason: row.recoveryReason,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() })),
    next_cursor: rows.length > 100 ? rows[99]?.id ?? null : null };
}

export async function readSmsRecoveryResource(id: string) {
  const db = getAdminPrisma();
  const row = await db.billingSmsNumberResource.findUnique({ where: { id }, select: {
    id: true, serviceId: true, orgId: true, phoneNumber: true, country: true, state: true,
    recoveryReason: true, accountSid: true, phoneNumberSid: true, offerId: true,
    quote: { select: { id: true, finalAmount: true, finalCurrency: true, expiresAt: true, createdAt: true } },
  } });
  if (!row) throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_RESOURCE_NOT_FOUND');
  const subscriptions = row.offerId ? await db.billingRecurringAddonSubscription.findMany({
    where: { serviceId: row.serviceId, offerId: row.offerId, orgId: row.orgId },
    orderBy: { createdAt: 'desc' }, take: 20,
    select: { id: true, stripeSubscriptionId: true, initialInvoiceId: true, initialInvoicePaidAt: true,
      status: true, livemode: true, cancelAtPeriodEnd: true,
      account: { select: { stripeAccountId: true } },
    },
  }) : [];
  return { id: row.id, service_id: row.serviceId, organisation_id: row.orgId,
    phone_number: row.phoneNumber, country: row.country, state: row.state,
    recovery_reason: row.recoveryReason, account_sid: row.accountSid,
    phone_number_sid: row.phoneNumberSid, quote: { id: row.quote.id,
      final_amount: row.quote.finalAmount.toString(), final_currency: row.quote.finalCurrency,
      expires_at: row.quote.expiresAt.toISOString(),
      created_at: row.quote.createdAt.toISOString() },
    subscriptions: subscriptions.map((item) => ({ id: item.id,
      stripe_account_id: item.account.stripeAccountId, stripe_subscription_id: item.stripeSubscriptionId,
      initial_invoice_id: item.initialInvoiceId, initial_invoice_paid_at: item.initialInvoicePaidAt?.toISOString() ?? null,
      status: item.status, livemode: item.livemode, cancel_at_period_end: item.cancelAtPeriodEnd })),
    refund_action_available: row.state === 'refund_required' && subscriptions.some((item) => item.initialInvoiceId && item.initialInvoicePaidAt),
    operator_next_step: 'Review the exact provider resource and original Stripe account/mode/subscription/invoice. Create any refund through the authorized Stripe operator workflow, then verify its existing refund IDs here. Only complete original cash refund evidence and a canceled subscription can end refund_required. This page never creates a refund; partial, pending or mismatched evidence stays unresolved.',
  };
}
