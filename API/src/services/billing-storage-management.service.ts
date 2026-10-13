import type { PrismaClient } from '@prisma/client';
import type { ProductEntitlementRequest, StorageManagerV1 } from '@unlikeotherai/billing-statement-protocol';
import { AppError } from '../utils/errors.js';
import { resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { readBoundStorageInvoice } from './billing-storage-invoice.service.js';
import { storageRuntime, STORAGE_CONSENT_TEXT, STORAGE_CONSENT_VERSION, type StorageDependencies } from './billing-storage-mandate.service.js';

function invoiceRecoveryUrl(status: string | null | undefined, value: string | null | undefined): string | null {
  if (status !== 'open' || !value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['invoice.stripe.com', 'pay.stripe.com'].includes(url.hostname) || url.username || url.password) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_RECOVERY_URL_INVALID');
  }
  return url.toString();
}

export async function storageManagementSnapshot(prisma: PrismaClient, input: {
  serviceId: string; request: ProductEntitlementRequest; privateAtCost: boolean;
}, deps?: StorageDependencies): Promise<StorageManagerV1> {
  const now = deps?.now?.() ?? new Date();
  const runtime = storageRuntime(deps);
  const account = await resolveStripeAccountContext(runtime.stripe, runtime.livemode, prisma);
  const scope = { serviceId: input.serviceId, orgId: input.request.organisation_id, accountId: account.id };
  const [region, mandate, subscription, expansion, incidents] = await Promise.all([
    prisma.billingOrganisationRegion.findUnique({ where: { orgId: input.request.organisation_id } }),
    prisma.billingStorageMandate.findFirst({ where: { ...scope, revokedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.billingStorageSubscription.findUnique({ where: { serviceId_orgId_accountId: scope } }),
    prisma.billingStorageExpansion.findFirst({ where: { serviceId: input.serviceId, orgId: input.request.organisation_id,
      state: { not: 'paid' } }, orderBy: { createdAt: 'desc' } }),
    prisma.billingCommercialIncident.findMany({ where: { ...scope,
      category: { in: ['seat', 'storage'] }, resolvedAt: null }, orderBy: [{ graceEndsAt: 'asc' }, { failedAt: 'asc' }, { id: 'asc' }] }),
  ]);
  const incident = incidents[0];
  const paymentRecoveries: StorageManagerV1['payment_recoveries'] = [];
  for (const debt of incidents.filter((row) => row.category === 'storage')) {
    const verified = await readBoundStorageInvoice(debt.invoiceId, runtime.stripe, account, prisma);
    if (verified.binding.expansion.serviceId !== input.serviceId || verified.binding.expansion.orgId !== input.request.organisation_id ||
      verified.binding.expansion.id !== debt.storageExpansionId) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_RECOVERY_INCIDENT_DRIFT');
    }
    // A paid remote invoice is not durable cash proof. Keep the debt visible until
    // the producer commits independently verified payment evidence.
    paymentRecoveries.push({ incident_id: debt.id, invoice_id: verified.invoice.id,
      invoice_url: invoiceRecoveryUrl(verified.invoice.status, verified.invoice.hosted_invoice_url),
      invoice_amount_minor: verified.invoice.amount_due.toString(), invoice_currency: verified.invoice.currency.toUpperCase(),
      grace_ends_at: debt.graceEndsAt.toISOString() });
  }
  const catalog = region ? await prisma.billingStorageCatalog.findFirst({ where: { serviceId: input.serviceId,
    accountId: account.id, currency: region.currency }, orderBy: { version: 'desc' } }) : null;
  const subscribedCatalog = subscription ? await prisma.billingStorageCatalog.findUniqueOrThrow({ where: { id: subscription.catalogId } }) : null;
  let pending: StorageManagerV1['pending_expansion'] = null;
  let recovered = false;
  if (expansion) {
    const attempt = await prisma.billingStoragePaymentAttempt.findFirstOrThrow({ where: { expansionId: expansion.id }, orderBy: { generation: 'desc' } });
    let invoiceUrl: string | null = null;
    let amount: string | null = null;
    let currency: string | null = null;
    if (attempt.stripeInvoiceId) {
      const { invoice, remote, binding } = await readBoundStorageInvoice(attempt.stripeInvoiceId, runtime.stripe, account, prisma);
      if (binding.expansion.id !== expansion.id || binding.attempt.id !== attempt.id || binding.expansion.serviceId !== input.serviceId ||
        binding.expansion.orgId !== input.request.organisation_id) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_RECOVERY_INVOICE_DRIFT');
      }
      amount = invoice.amount_due.toString();
      currency = invoice.currency.toUpperCase();
      invoiceUrl = invoiceRecoveryUrl(invoice.status, invoice.hosted_invoice_url);
      recovered = remote.status === 'incomplete_expired' && invoice.amount_paid === 0 &&
        ['void', 'uncollectible'].includes(invoice.status ?? '') && remote.metadata.uoa_storage_attempt_id === attempt.id;
    }
    pending = { id: expansion.id, state: expansion.state, required_blocks: expansion.toBlocks,
      invoice_id: attempt.stripeInvoiceId, invoice_url: invoiceUrl, invoice_amount_minor: amount, invoice_currency: currency,
      grace_ends_at: incident?.graceEndsAt.toISOString() ?? null,
      recovery_action: recovered ? { method: 'POST', path: '/billing/v1/storage/recover', body: {
        ...input.request, expansion_id: expansion.id,
      } } : null };
  }
  return { schema_version: 1, can_manage: true, product: input.request.product,
    organisation_id: input.request.organisation_id, subject: { team_id: input.request.team_id, user_id: input.request.user_id },
    state: input.privateAtCost ? 'cost_evidence_required' : !region ? 'billing_region_required' : !catalog ? 'catalog_required'
      : recovered || paymentRecoveries.length ? 'recovery_required' : pending ? 'payment_pending' : mandate?.state === 'accepted' ? 'ready' : 'setup_available',
    setup: !input.privateAtCost && catalog ? { unit_amount_minor: catalog.unitAmountMinor.toString(), currency: catalog.currency,
      block_bytes: '1000000000000', cadence: 'month', current_cycle_proration_minor: '0',
      consent_text: STORAGE_CONSENT_TEXT, consent_version: STORAGE_CONSENT_VERSION,
      action: { method: 'POST', path: '/billing/v1/storage/mandate', body: {
        ...input.request, catalog_id: catalog.id, consent_version: STORAGE_CONSENT_VERSION, accepted: true,
      } } } : null,
    mandate: mandate ? { id: mandate.id, state: mandate.state } : null,
    subscription: subscription && subscribedCatalog ? { purchased_blocks: subscription.purchasedBlocks,
      pending_blocks: subscription.pendingBlocks, currency: subscribedCatalog.currency,
      unit_amount_minor: subscribedCatalog.unitAmountMinor.toString(),
      current_period_start: subscription.currentPeriodStart?.toISOString() ?? null,
      current_period_end: subscription.currentPeriodEnd?.toISOString() ?? null } : null,
    pending_expansion: pending, payment_recoveries: paymentRecoveries, observed_at: now.toISOString(),
    valid_until: new Date(Math.min(now.getTime() + 60_000, incident && incident.graceEndsAt > now
      ? incident.graceEndsAt.getTime() : Infinity)).toISOString() };
}
