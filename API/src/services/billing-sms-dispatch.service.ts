import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { BillingSmsClaimRequestV1, BillingSmsReleaseRequestV1, BillingSmsReservationReadRequestV1,
  BillingSmsReservationV1, BillingSmsReleaseResultV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockSmsCredential } from './billing-sms-authority.service.js';
import { lockSmsDispatchAuthority, publicSmsReservation } from './billing-sms-reservation.service.js';
import { lockSmsQuote } from './billing-sms-money.service.js';
import { readSmsNumber, type SmsNumberDependencies } from './billing-sms-number.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { releaseBudgetDispatch } from './billing-credit-budget-dispatch.service.js';

export async function readSmsReservation(input: { request: BillingSmsReservationReadRequestV1;
  credential: VerifiedBillingAppKey }, deps?: Pick<SmsNumberDependencies, 'prisma'>): Promise<BillingSmsReservationV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    const row = await tx.billingSmsReservation.findUnique({ where: { dispatchId: input.request.dispatch_id } });
    if (!row || row.serviceId !== input.credential.service.id || input.request.product !== input.credential.service.identifier) {
      throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_RESERVATION_NOT_FOUND');
    }
    return publicSmsReservation(row);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

export async function claimSmsDispatch(input: { request: BillingSmsClaimRequestV1;
  credential: VerifiedBillingAppKey }, deps: SmsNumberDependencies): Promise<BillingSmsReservationV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const observed = await prisma.billingSmsReservation.findUnique({ where: { dispatchId: input.request.dispatch_id } });
  if (!observed || observed.serviceId !== input.credential.service.id ||
      input.request.product !== input.credential.service.identifier) throw new AppError('NOT_FOUND', 404);
  const status = await readSmsNumber({ product: input.request.product, resource_id: observed.numberId,
    credential: input.credential }, deps);
  if (!status.acquisition_authorized || status.organisation_id !== observed.orgId) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_PAYMENT_NOT_ACTIVE');
  }
  const number = await prisma.billingSmsNumberResource.findUniqueOrThrow({ where: { id: observed.numberId } });
  if (!number.phoneNumberSid) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_NUMBER_NOT_ACTIVE');
  const provider = await deps.provider.ownedNumber(observed.accountSid, number.phoneNumberSid);
  if (!provider?.sms || provider.phone !== observed.from) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_NUMBER_NOT_ACTIVE');
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    await lockSmsDispatchAuthority(tx, observed, input.credential);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${observed.numberId}, 0))::text`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_sms_number_resources WHERE id = ${observed.numberId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.request.dispatch_id}, 0))::text`);
    const row = await tx.billingSmsReservation.findUniqueOrThrow({ where: { dispatchId: input.request.dispatch_id } });
    if (row.serviceId !== input.credential.service.id || row.requestFingerprint !== input.request.request_fingerprint) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_DISPATCH_BINDING_CONFLICT');
    }
    await lockSmsDispatchAuthority(tx, row, input.credential);
    if (row.state !== 'reserved') return publicSmsReservation(row);
    const live = await tx.billingSmsNumberResource.findFirst({ where: {
      id: row.numberId, state: 'active', phoneNumberSid: number.phoneNumberSid, accountSid: row.accountSid,
    } });
    if (!live) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_NUMBER_NOT_ACTIVE');
    await lockSmsQuote(tx, { quoteId: row.quoteId, serviceId: row.serviceId, orgId: row.orgId,
      direction: 'outbound', destination: row.to, accountSid: row.accountSid, now: deps.now?.() ?? new Date() });
    const token = randomBytes(32).toString('base64url');
    const claimed = await tx.billingSmsReservation.update({ where: { id: row.id }, data: {
      state: 'dispatching', dispatchTokenDigest: createHash('sha256').update(token).digest('hex'),
      dispatchClaimedAt: new Date(),
    } });
    return publicSmsReservation(claimed, token);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

export async function releaseSmsDispatch(input: { request: BillingSmsReleaseRequestV1;
  credential: VerifiedBillingAppKey }, deps?: Pick<SmsNumberDependencies, 'prisma'>): Promise<BillingSmsReleaseResultV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (input.request.product !== input.credential.service.identifier || input.request.proof !== 'no_provider_dispatch') {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_RELEASE_PROOF_INVALID');
  }
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.request.dispatch_id}, 0))::text`);
    const row = await tx.billingSmsReservation.findUnique({ where: { dispatchId: input.request.dispatch_id } });
    if (!row) {
      if (input.request.dispatch_token !== null) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RELEASE_PROOF_INVALID');
      const prior = await tx.billingSmsDispatchCancellation.findUnique({ where: { dispatchId: input.request.dispatch_id } });
      if (prior && (prior.serviceId !== input.credential.service.id ||
          prior.requestFingerprint !== input.request.request_fingerprint)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_DISPATCH_BINDING_CONFLICT');
      }
      if (!prior) await tx.billingSmsDispatchCancellation.create({ data: {
        dispatchId: input.request.dispatch_id, serviceId: input.credential.service.id,
        appKeyId: input.credential.id, requestFingerprint: input.request.request_fingerprint,
      } });
      return { dispatch_id: input.request.dispatch_id, state: 'released', can_dispatch: false };
    }
    if (row.serviceId !== input.credential.service.id || row.requestFingerprint !== input.request.request_fingerprint) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_DISPATCH_BINDING_CONFLICT');
    }
    if (row.state === 'released') return publicSmsReservation(row);
    if (!['reserved', 'dispatching'].includes(row.state) || row.messageSid) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RELEASE_OUTCOME_UNPROVEN');
    }
    if (row.state === 'dispatching') {
      const token = input.request.dispatch_token;
      const digest = token ? createHash('sha256').update(token).digest() : null;
      const expected = row.dispatchTokenDigest ? Buffer.from(row.dispatchTokenDigest, 'hex') : null;
      if (!digest || !expected || !timingSafeEqual(digest, expected)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_RELEASE_OUTCOME_UNPROVEN');
      }
    }
    await releaseBudgetDispatch(tx, row.dispatchId);
    return publicSmsReservation(await tx.billingSmsReservation.update({ where: { id: row.id }, data: { state: 'released' } }));
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}
