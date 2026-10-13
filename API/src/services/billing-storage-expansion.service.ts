import { type PrismaClient, type BillingStoragePaymentAttempt } from '@prisma/client';
import type Stripe from 'stripe';
import type { StorageEnsureRequestV1, StorageEnsureV1, StorageObservationRequestV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockCommercialAuthority } from './billing-product-authority.service.js';
import { privateCompanyPolicy } from './billing-product-private-policy.service.js';
import { FREE_STORAGE_BYTES, STORAGE_BLOCK_BYTES } from './billing-storage-units.service.js';
import { storageRuntime, type StorageDependencies } from './billing-storage-mandate.service.js';
import { assertStripeObjectLivemode, resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';
import { verifyStoragePrice } from './billing-storage-catalog.service.js';

export function storageBlocks(bytes: bigint): number {
  const blocks = bytes <= FREE_STORAGE_BYTES ? 0n : (bytes + STORAGE_BLOCK_BYTES - 1n) / STORAGE_BLOCK_BYTES;
  if (blocks > 1_000_000n) throw new AppError('BAD_REQUEST', 400, 'BILLING_STORAGE_CAPACITY_UNSUPPORTED');
  return Number(blocks);
}
export async function effectiveStorageCapacity(prisma: Pick<PrismaClient, 'billingStorageSubscription' | 'billingCommercialIncident' | 'billingStorageExpansion'>,
  serviceId: string, orgId: string, now: Date) {
  const subscriptions = await prisma.billingStorageSubscription.findMany({ where: { serviceId, orgId,
    state: { notIn: ['canceled', 'ended'] } } });
  if (subscriptions.length > 1) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_ACCOUNT_AMBIGUOUS');
  const row = subscriptions[0];
  const incident = await prisma.billingCommercialIncident.findFirst({ where: { serviceId, orgId,
    category: { in: ['seat', 'storage'] }, resolvedAt: null }, orderBy: [{ graceEndsAt: 'asc' }, { failedAt: 'asc' }, { id: 'asc' }] });
  const restricted = Boolean(incident && incident.graceEndsAt <= now);
  const pendingExpansion = row?.pendingBlocks ? await prisma.billingStorageExpansion.findFirst({ where: { serviceId, orgId,
    subscriptionId: row.id, toBlocks: { gte: row.pendingBlocks }, state: { not: 'paid' } } }) : null;
  const pendingIncident = pendingExpansion && !restricted ? await prisma.billingCommercialIncident.findFirst({ where: {
    serviceId, orgId, category: 'storage', resolvedAt: null, graceEndsAt: { gt: now },
    storageExpansionId: pendingExpansion.id,
  } }) : null;
  const storageGrace = row && !restricted ? await prisma.billingCommercialIncident.findFirst({ where: {
    serviceId, orgId, accountId: row.accountId, category: 'storage', resolvedAt: null, graceEndsAt: { gt: now },
  } }) : null;
  if (row && row.purchasedBlocks > 0 && (!row.paidThrough || row.paidThrough <= now) && !storageGrace && !restricted) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_RENEWAL_RECONCILIATION_REQUIRED');
  }
  const blocks = row ? Math.max(row.purchasedBlocks, pendingIncident ? row.pendingBlocks : 0) : 0;
  return { bytes: blocks > 0 ? BigInt(blocks) * STORAGE_BLOCK_BYTES : FREE_STORAGE_BYTES,
    blocks, restricted, incident, row };
}

export async function ensureStorageCapacity(input: { request: StorageEnsureRequestV1;
  credential: VerifiedBillingAppKey }, deps?: StorageDependencies): Promise<StorageEnsureV1> {
  const { request, credential } = input;
  const prisma = deps?.prisma ?? getAdminPrisma();
  const required = BigInt(request.minimum_capacity_bytes);
  const target = storageBlocks(required);
  const prepared = await prisma.$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential, product: request.product,
      organisationId: request.organisation_id, purpose: 'COMMERCIAL_WORKER' });
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${request.organisation_id} FOR UPDATE`;
    const now = deps?.now?.() ?? new Date();
    const current = await effectiveStorageCapacity(tx as PrismaClient, credential.service.id, request.organisation_id, now);
    const response = (state: StorageEnsureV1['state']): StorageEnsureV1 => ({ product: request.product,
      organisation_id: request.organisation_id, operation_id: request.operation_id,
      schema_version: 1, state, capacity_bytes: current.bytes.toString(),
      required_blocks: target, grace_ends_at: current.incident?.graceEndsAt.toISOString() ?? null });
    const replay = await tx.billingStorageExpansion.findUnique({ where: { serviceId_orgId_operationId: {
      serviceId: credential.service.id, orgId: request.organisation_id, operationId: request.operation_id,
    } } });
    if (replay && replay.minimumBytes !== required) throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_OPERATION_CONFLICT');
    if (current.restricted) return { response: response('restricted') };
    if (required <= current.bytes) return { response: response('admitted') };
    if (await privateCompanyPolicy(tx, credential.service.id, request.organisation_id, now)) {
      return { response: response('reconciliation_required') };
    }
    const unresolved = await tx.billingStorageExpansion.findFirst({ where: { serviceId: credential.service.id,
      orgId: request.organisation_id, state: { not: 'paid' } }, orderBy: { createdAt: 'asc' } });
    if (unresolved) return { response: response(unresolved.state === 'reconciliation_required'
      ? 'reconciliation_required' : 'payment_pending'), expansion: unresolved };
    const mandates = await tx.billingStorageMandate.findMany({ where: { serviceId: credential.service.id,
      orgId: request.organisation_id, state: 'accepted', revokedAt: null }, orderBy: { acceptedAt: 'desc' }, take: 2 });
    const mandate = mandates[0];
    if (!mandate?.stripePaymentMethodId) return { response: response('setup_required') };
    const subscription = current.row;
    if (subscription && subscription.accountId !== mandate.accountId) {
      return { response: response('reconciliation_required') };
    }
    const expansion = await tx.billingStorageExpansion.create({ data: { serviceId: credential.service.id,
      orgId: request.organisation_id, mandateId: mandate.id, subscriptionId: subscription?.id ?? null,
      operationId: request.operation_id, minimumBytes: required, fromBlocks: subscription?.purchasedBlocks ?? 0,
      toBlocks: target } });
    await tx.billingStoragePaymentAttempt.create({ data: { expansionId: expansion.id, mandateId: mandate.id, generation: 1 } });
    return { response: response('payment_pending'), expansion };
  });
  if (prepared.expansion?.state === 'pending') await dispatchStorageExpansion(prepared.expansion.id, deps);
  return prepared.response;
}

export async function recordStorageObservation(input: { request: StorageObservationRequestV1;
  credential: VerifiedBillingAppKey }, deps?: { prisma?: PrismaClient }) {
  const request = input.request;
  const blob = BigInt(request.blob_bytes), database = BigInt(request.database_bytes), revision = BigInt(request.revision);
  if (blob + database > 9_223_372_036_854_775_807n || revision > 9_223_372_036_854_775_807n ||
    Date.parse(request.observed_at) > Date.now() + 5_000) throw new AppError('BAD_REQUEST', 400, 'BILLING_STORAGE_OBSERVATION_INVALID');
  return (deps?.prisma ?? getAdminPrisma()).$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential: input.credential, product: request.product,
      organisationId: request.organisation_id, purpose: 'COMMERCIAL_WORKER' });
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${request.organisation_id} FOR UPDATE`;
    const scope = { serviceId: input.credential.service.id, orgId: request.organisation_id };
    const byId = await tx.billingStorageObservation.findUnique({ where: {
      serviceId_orgId_observationId: { ...scope, observationId: request.observation_id },
    } });
    const same = await tx.billingStorageObservation.findUnique({ where: { serviceId_orgId_revision: { ...scope, revision } } });
    if (byId || same) {
      const old = byId ?? same;
      if (!old) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_OBSERVATION_UNPROVEN');
      if (old.revision !== revision || old.observationId !== request.observation_id || old.blobBytes !== blob ||
        old.databaseBytes !== database || old.measurementVersion !== request.measurement_version ||
        old.observedAt.toISOString() !== request.observed_at) throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_OBSERVATION_CONFLICT');
      return { accepted: true, superseded: false, revision: old.revision.toString() };
    }
    const current = await tx.billingStorageObservation.findFirst({ where: scope, orderBy: { revision: 'desc' } });
    if (current && current.revision > revision) return { accepted: true, superseded: true, revision: current.revision.toString() };
    if (current && current.observedAt > new Date(request.observed_at)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_STORAGE_OBSERVATION_TIME_REGRESSED');
    }
    await tx.billingStorageObservation.create({ data: { ...scope, observationId: request.observation_id,
      measurementVersion: request.measurement_version, revision, blobBytes: blob, databaseBytes: database,
      observedAt: new Date(request.observed_at) } });
    return { accepted: true, superseded: false, revision: revision.toString() };
  });
}

/** Recover the exact generation after response loss; never replace unknown egress. */
export async function locateStorageAttempt(stripe: Stripe, attempt: BillingStoragePaymentAttempt,
  customerId: string, livemode: boolean, prisma: PrismaClient) {
  if (attempt.stripeSubscriptionId) {
    const remote = await stripe.subscriptions.retrieve(attempt.stripeSubscriptionId);
    assertStripeObjectLivemode(remote, livemode);
    return remote;
  }
  if (attempt.scanComplete) return null;
    const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100,
      ...(attempt.scanCursor ? { starting_after: attempt.scanCursor } : {}) });
    const found = list.data.filter((row) => row.metadata.uoa_storage_attempt_id === attempt.id);
    if (found.length > 1) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_ATTEMPT_AMBIGUOUS');
    if (found[0]) {
      assertStripeObjectLivemode(found[0], livemode);
      await prisma.billingStoragePaymentAttempt.updateMany({ where: { id: attempt.id,
        stripeSubscriptionId: null }, data: { stripeSubscriptionId: found[0].id } });
      return found[0];
    }
    const cursor = list.data.at(-1)?.id ?? attempt.scanCursor;
    if (list.has_more && cursor === attempt.scanCursor) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_ATTEMPT_SCAN_UNRESOLVED');
    }
    await prisma.billingStoragePaymentAttempt.updateMany({ where: { id: attempt.id,
      scanCursor: attempt.scanCursor, stripeSubscriptionId: null },
      data: { scanCursor: cursor, scanComplete: !list.has_more } });
    if (list.has_more) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_ATTEMPT_SCAN_CONTINUING');
    return null;
}

export async function dispatchStorageExpansion(id: string, deps?: StorageDependencies) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { stripe, livemode } = storageRuntime(deps);
  const account = await resolveStripeAccountContext(stripe, livemode, prisma);
  const prepared = await prisma.$transaction(async (tx) => {
    const candidate = await tx.billingStorageExpansion.findUniqueOrThrow({ where: { id } });
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${candidate.orgId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM billing_storage_expansions WHERE id=${id} FOR UPDATE`;
    const expansion = await tx.billingStorageExpansion.findUniqueOrThrow({ where: { id } });
    if (expansion.state === 'paid') return null;
    const attempt = await tx.billingStoragePaymentAttempt.findFirstOrThrow({ where: { expansionId: id }, orderBy: { generation: 'desc' } });
    const mandate = await tx.billingStorageMandate.findUniqueOrThrow({ where: { id: attempt.mandateId } });
    const catalog = await tx.billingStorageCatalog.findUniqueOrThrow({ where: { id: mandate.catalogId } });
    const subscription = expansion.subscriptionId && attempt.generation === 1
      ? await tx.billingStorageSubscription.findUniqueOrThrow({ where: { id: expansion.subscriptionId } }) : null;
    if (mandate.accountId !== account.id || catalog.accountId !== account.id || mandate.state !== 'accepted' ||
      mandate.revokedAt || !mandate.stripePaymentMethodId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_MANDATE_NOT_ACTIVE');
    const now = deps?.now?.() ?? new Date();
    const enrolled = await tx.billingProductEnrollment.findFirst({ where: { serviceId: expansion.serviceId,
      orgId: expansion.orgId, active: true } });
    const activeCompany = await tx.organisation.findFirst({ where: { id: expansion.orgId, lifecycleStatus: 'ACTIVE' } });
    const service = await tx.billingService.findFirst({ where: { id: expansion.serviceId, active: true } });
    if (!enrolled || !activeCompany || !service) throw new AppError('FORBIDDEN', 403, 'BILLING_STORAGE_SCOPE_REVOKED');
    if (!attempt.firstAttemptedAt) await tx.billingStoragePaymentAttempt.update({ where: { id: attempt.id }, data: { firstAttemptedAt: now } });
    await tx.billingStorageExpansion.update({ where: { id }, data: { state: 'processing',
      firstAttemptedAt: expansion.firstAttemptedAt ?? now } });
    return { expansion, attempt, mandate, catalog, subscription };
  });
  if (!prepared) return;
  const paymentMethodId = prepared.mandate.stripePaymentMethodId;
  if (!paymentMethodId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_MANDATE_NOT_ACTIVE');
  await verifyStoragePrice(stripe, { priceId: prepared.catalog.stripePriceId, currency: prepared.catalog.currency,
    unitAmountMinor: prepared.catalog.unitAmountMinor, product: 'nessie', account });
  const method = await stripe.paymentMethods.retrieve(paymentMethodId);
  assertStripeObjectLivemode(method, livemode);
  if (stripeExternalId(method.customer) !== prepared.mandate.stripeCustomerId) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_PAYMENT_METHOD_INVALID');
  let remote = prepared.subscription ? await stripe.subscriptions.retrieve(prepared.subscription.stripeSubscriptionId)
    : await locateStorageAttempt(stripe, prepared.attempt, prepared.mandate.stripeCustomerId, livemode, prisma);
  const metadata = { uoa_storage_expansion_id: id, uoa_storage_attempt_id: prepared.attempt.id,
    uoa_storage_mandate_id: prepared.mandate.id, uoa_service: 'nessie' };
  if (!remote) {
    const first = prepared.attempt.firstAttemptedAt ?? new Date();
    if (Date.now() - first.getTime() >= 23 * 3_600_000) {
      await prisma.billingStorageExpansion.update({ where: { id }, data: { state: 'reconciliation_required' } });
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_ATTEMPT_RECONCILIATION_REQUIRED');
    }
    remote = await stripe.subscriptions.create({ customer: prepared.mandate.stripeCustomerId,
      items: [{ price: prepared.catalog.stripePriceId, quantity: prepared.expansion.toBlocks }],
      default_payment_method: paymentMethodId, collection_method: 'charge_automatically',
      payment_behavior: 'allow_incomplete', metadata }, { idempotencyKey: `uoa:storage-attempt:${prepared.attempt.id}` });
  } else if (prepared.subscription && remote.metadata.uoa_storage_attempt_id !== prepared.attempt.id) {
    const item = remote.items.data[0];
    if (!item || item.id !== prepared.subscription.stripeItemId || remote.status !== 'active') {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_EXPANSION_SOURCE_UNRESOLVED');
    }
    remote = await stripe.subscriptions.update(remote.id, { items: [{ id: item.id, quantity: prepared.expansion.toBlocks }],
      proration_behavior: 'always_invoice', proration_date: Math.floor(prepared.expansion.createdAt.getTime() / 1000),
      payment_behavior: 'allow_incomplete', metadata }, { idempotencyKey: `uoa:storage-attempt:${prepared.attempt.id}` });
  }
  assertStripeObjectLivemode(remote, livemode);
  const item = remote.items.data[0];
  if (remote.items.data.length !== 1 || !item || item.quantity !== prepared.expansion.toBlocks ||
    item.price.id !== prepared.catalog.stripePriceId || stripeExternalId(remote.customer) !== prepared.mandate.stripeCustomerId ||
    Object.entries(metadata).some(([key, value]) => remote!.metadata[key] !== value)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_STORAGE_SUBSCRIPTION_BINDING_INVALID');
  }
  const acceptedRemote = remote;
  const invoiceId = stripeExternalId(acceptedRemote.latest_invoice);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${prepared.expansion.orgId} FOR UPDATE`;
    const current = await tx.billingStorageExpansion.findUniqueOrThrow({ where: { id } });
    const latest = await tx.billingStoragePaymentAttempt.findFirstOrThrow({ where: { expansionId: id }, orderBy: { generation: 'desc' } });
    await tx.billingStoragePaymentAttempt.update({ where: { id: prepared.attempt.id },
      data: { stripeSubscriptionId: acceptedRemote.id, stripeInvoiceId: invoiceId } });
    if (latest.id !== prepared.attempt.id || await tx.billingStorageExpansion.findFirst({ where: {
      serviceId: current.serviceId, orgId: current.orgId, toBlocks: { gt: current.toBlocks },
    } })) return;
    const row = await tx.billingStorageSubscription.upsert({ where: { serviceId_orgId_accountId: {
      serviceId: current.serviceId, orgId: current.orgId, accountId: account.id,
    } }, create: { serviceId: current.serviceId, orgId: current.orgId, accountId: account.id,
      mandateId: prepared.mandate.id, catalogId: prepared.catalog.id, stripeSubscriptionId: acceptedRemote.id,
      stripeItemId: item.id, state: acceptedRemote.status, pendingBlocks: current.state === 'paid' ? 0 : current.toBlocks,
      purchasedBlocks: current.state === 'paid' ? current.toBlocks : 0,
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd: new Date(item.current_period_end * 1000) }, update: {
      stripeSubscriptionId: acceptedRemote.id, stripeItemId: item.id, state: acceptedRemote.status,
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd: new Date(item.current_period_end * 1000),
      ...(current.state === 'paid' ? {} : { pendingBlocks: current.toBlocks }),
    } });
    await tx.billingStorageExpansion.update({ where: { id }, data: { subscriptionId: row.id,
      stripeInvoiceId: invoiceId } });
  });
}
