import { BillingAssignmentScope } from '@prisma/client';
import type { ProductEntitlementRequest, StorageRecoveryResultV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { verifyBillingActor } from './billing-actor.service.js';
import { commercialMember, lockCommercialAuthority } from './billing-product-authority.service.js';
import { authorizeBillingCustomerAction, BILLING_CUSTOMER_ACTION } from './billing-customer-action-intent.service.js';
import { storageRuntime, type StorageDependencies } from './billing-storage-mandate.service.js';
import { locateStorageAttempt, dispatchStorageExpansion } from './billing-storage-expansion.service.js';
import { resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { readBoundStorageInvoice } from './billing-storage-invoice.service.js';

export async function recoverStorage(input: { request: ProductEntitlementRequest & { expansion_id: string; mandate_id?: string };
  actorToken: string; credential: VerifiedBillingAppKey }, deps?: StorageDependencies): Promise<StorageRecoveryResultV1> {
  const { request, credential } = input;
  const actor = await verifyBillingActor({ token: input.actorToken, credential, endpoint: '/billing/v1/storage/recover',
    request: { product: request.product, organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id } });
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { stripe, livemode } = storageRuntime(deps);
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  const prepared = await prisma.$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential, product: request.product, organisationId: request.organisation_id, purpose: 'CUSTOMER_LIFECYCLE' });
    if (!await commercialMember(tx, { organisationId: request.organisation_id, teamId: request.team_id,
      userId: request.user_id, tokenVersion: actor.tv })) throw new AppError('FORBIDDEN', 403);
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${request.organisation_id} FOR UPDATE`;
    const expansion = await tx.billingStorageExpansion.findFirstOrThrow({ where: { id: request.expansion_id,
      serviceId: credential.service.id, orgId: request.organisation_id } });
    const attempt = await tx.billingStoragePaymentAttempt.findFirstOrThrow({ where: { expansionId: expansion.id }, orderBy: { generation: 'desc' } });
    const oldMandate = await tx.billingStorageMandate.findUniqueOrThrow({ where: { id: attempt.mandateId } });
    const mandate = await tx.billingStorageMandate.findFirstOrThrow({ where: { id: request.mandate_id ?? oldMandate.id,
      serviceId: credential.service.id, orgId: request.organisation_id, accountId: account.id,
      catalogId: oldMandate.catalogId, stripeCustomerId: oldMandate.stripeCustomerId,
      state: 'accepted', revokedAt: null, stripePaymentMethodId: { not: null } } });
    const action = await authorizeBillingCustomerAction({ credential, actor, organisationId: request.organisation_id,
      teamId: request.team_id, userId: request.user_id, authorityScope: BillingAssignmentScope.ORGANISATION,
      operation: BILLING_CUSTOMER_ACTION.STORAGE_RECOVERY, request }, { prisma: tx });
    return { expansion, attempt, mandate, action };
  });
  const replay = await prisma.billingStoragePaymentAttempt.findUnique({ where: { recoveryActionIntentId: prepared.action.id } });
  const base = { schema_version: 1 as const, product: request.product, organisation_id: request.organisation_id,
    expansion_id: prepared.expansion.id };
  if (replay) return { ...base, attempt_id: replay.id, state: prepared.expansion.state === 'paid' ? 'paid'
    : prepared.expansion.state === 'reconciliation_required' ? 'reconciliation_required' : 'payment_pending' };
  if (prepared.expansion.state === 'paid') return { ...base, attempt_id: null, state: 'paid' };
  const remote = await locateStorageAttempt(stripe, prepared.attempt, prepared.mandate.stripeCustomerId, livemode, prisma);
  if (!remote) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_ATTEMPT_UNPROVEN');
  const invoiceId = prepared.attempt.stripeInvoiceId ?? stripeExternalId(remote.latest_invoice);
  const verified = invoiceId ? await readBoundStorageInvoice(invoiceId, stripe, account, prisma) : null;
  const invoice = verified?.invoice;
  if (remote.status !== 'incomplete_expired' || !invoice || !['void', 'uncollectible'].includes(invoice.status ?? '') ||
    verified?.binding.attempt.id !== prepared.attempt.id || verified.binding.expansion.id !== prepared.expansion.id ||
    verified.remote.id !== remote.id || verified.remote.status !== 'incomplete_expired' ||
    invoice.amount_paid !== 0 || stripeExternalId(invoice.customer) !== prepared.mandate.stripeCustomerId ||
    stripeExternalId(invoice.parent?.subscription_details?.subscription) !== remote.id ||
    remote.metadata.uoa_storage_attempt_id !== prepared.attempt.id || remote.metadata.uoa_storage_expansion_id !== prepared.expansion.id) {
    // A live attempt is recovered by Stripe's existing automatic-payment/portal
    // path. Never replace it or convert a network failure into a new charge.
    throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_ATTEMPT_NOT_TERMINAL_UNPAID');
  }
  const next = await prisma.$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential, product: request.product, organisationId: request.organisation_id, purpose: 'CUSTOMER_LIFECYCLE' });
    if (!await commercialMember(tx, { organisationId: request.organisation_id, teamId: request.team_id,
      userId: request.user_id, tokenVersion: actor.tv })) throw new AppError('FORBIDDEN', 403);
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${request.organisation_id} FOR UPDATE`;
    const current = await tx.billingStoragePaymentAttempt.findFirstOrThrow({ where: { expansionId: prepared.expansion.id }, orderBy: { generation: 'desc' } });
    if (current.id !== prepared.attempt.id) return current;
    const original = await tx.billingCommercialIncident.findFirst({ where: { storageExpansionId: prepared.expansion.id, resolvedAt: null }, orderBy: { graceEndsAt: 'asc' } });
    if (!original) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_ORIGINAL_FAILURE_REQUIRED');
    await tx.billingStoragePaymentAttempt.update({ where: { id: current.id }, data: {
      stripeInvoiceId: invoice.id, terminalUnpaidProvenAt: deps?.now?.() ?? new Date() } });
    const created = await tx.billingStoragePaymentAttempt.create({ data: { expansionId: prepared.expansion.id,
      mandateId: prepared.mandate.id, generation: current.generation + 1, recoveryActionIntentId: prepared.action.id } });
    await tx.billingStorageExpansion.update({ where: { id: prepared.expansion.id }, data: { state: 'pending' } });
    return created;
  });
  await dispatchStorageExpansion(prepared.expansion.id, deps);
  return { ...base, attempt_id: next.id, state: 'payment_pending' };
}
