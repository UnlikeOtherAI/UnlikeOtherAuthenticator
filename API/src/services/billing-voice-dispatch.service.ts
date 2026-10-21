import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient, BillingVoiceReservation } from '@prisma/client';
import type { BillingVoiceReadRequestV1, BillingVoiceClaimRequestV1, BillingVoiceReleaseRequestV1,
  BillingVoiceReservationV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockTelephoneCredential } from './billing-telephone-authority.service.js';
import { lockVoiceGrant } from './billing-voice-grant.service.js';
import { publicVoiceReservation, lockVoiceDispatch } from './billing-voice-reservation.service.js';
import { assertVoiceNumber, type VoiceDependencies } from './billing-voice-quote.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { releaseBudgetDispatch } from './billing-credit-budget-dispatch.service.js';

export async function voiceRow(tx: Prisma.TransactionClient, body: BillingVoiceReadRequestV1,
  credential: VerifiedBillingAppKey, fingerprint?: string): Promise<BillingVoiceReservation> {
  if (credential.purpose !== 'VOICE_RUNTIME' || body.product !== credential.service.identifier) throw new AppError('FORBIDDEN', 403);
  await lockTelephoneCredential(tx, credential);
  await lockVoiceDispatch(tx, body.dispatch_id);
  const row = await tx.billingVoiceReservation.findUnique({ where: { dispatchId: body.dispatch_id } });
  if (!row || row.serviceId !== credential.service.id) throw new AppError('NOT_FOUND', 404);
  if (fingerprint && row.requestFingerprint !== fingerprint) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_BINDING_CONFLICT');
  return row;
}
export async function readVoiceReservation(input: { request: BillingVoiceReadRequestV1; credential: VerifiedBillingAppKey },
  deps?: { prisma?: PrismaClient }): Promise<BillingVoiceReservationV1> {
  return runBillingSerializableTransaction(deps?.prisma ?? getAdminPrisma(), async tx =>
    publicVoiceReservation(await voiceRow(tx, input.request, input.credential)), 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}
export async function claimVoice(input: { request: BillingVoiceClaimRequestV1; credential: VerifiedBillingAppKey },
  deps: VoiceDependencies): Promise<BillingVoiceReservationV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const observed = await prisma.billingVoiceReservation.findUnique({ where: { dispatchId: input.request.dispatch_id } });
  if (!observed || observed.serviceId !== input.credential.service.id) throw new AppError('NOT_FOUND', 404);
  const grant = await runBillingSerializableTransaction(prisma, tx => lockVoiceGrant(tx, {
    grantId: observed.grantId, product: input.request.product, credential: input.credential,
  }), 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
  await assertVoiceNumber(grant, observed, input.credential, deps);
  if (deps.policy.accountSid !== observed.accountSid || Date.parse(deps.policy.expiresAt) <= Date.now()) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_VOICE_EVIDENCE_UNAVAILABLE');
  }
  return runBillingSerializableTransaction(prisma, async tx => {
    await lockVoiceGrant(tx, { grantId: observed.grantId, product: input.request.product, credential: input.credential });
    const row = await voiceRow(tx, input.request, input.credential, input.request.request_fingerprint);
    if (row.state !== 'reserved') return publicVoiceReservation(row);
    if (row.claimExpiresAt <= new Date()) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_CLAIM_EXPIRED');
    const number = await tx.billingSmsNumberResource.findFirst({ where: { id: row.numberId, state: 'active', accountSid: row.accountSid } });
    if (!number) throw new AppError('FORBIDDEN', 403, 'BILLING_VOICE_NUMBER_NOT_ACTIVE');
    const quote = await tx.billingVoiceQuote.findUniqueOrThrow({ where: { id: row.quoteId } });
    const frozen = quote.policyEvidence as Record<string, unknown>;
    if (Object.keys(deps.policy).some(key => frozen[key] !== deps.policy[key as keyof typeof deps.policy])) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_POLICY_CHANGED');
    }
    const token = randomBytes(32).toString('base64url');
    const claimed = await tx.billingVoiceReservation.update({ where: { id: row.id }, data: {
      state: 'dispatching', dispatchTokenDigest: createHash('sha256').update(token).digest('hex'), dispatchClaimedAt: new Date(),
    } });
    return publicVoiceReservation(claimed, token);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}
export async function releaseVoice(input: { request: BillingVoiceReleaseRequestV1; credential: VerifiedBillingAppKey },
  deps?: { prisma?: PrismaClient }): Promise<BillingVoiceReservationV1> {
  return runBillingSerializableTransaction(deps?.prisma ?? getAdminPrisma(), async tx => {
    const row = await voiceRow(tx, input.request, input.credential, input.request.request_fingerprint);
    if (input.request.proof !== 'no_provider_dispatch') throw new AppError('BAD_REQUEST', 400);
    if (row.state === 'released') return publicVoiceReservation(row);
    // Inbound CallSid already exists. Its final independently verified receipt must settle the hold.
    if (!['reserved', 'dispatching'].includes(row.state) || row.callSid) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_OUTCOME_UNPROVEN');
    }
    if (row.state === 'dispatching') {
      const digest = input.request.dispatch_token ? createHash('sha256').update(input.request.dispatch_token).digest() : null;
      const expected = row.dispatchTokenDigest ? Buffer.from(row.dispatchTokenDigest, 'hex') : null;
      if (!digest || !expected || !timingSafeEqual(digest, expected)) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_OUTCOME_UNPROVEN');
    }
    await releaseBudgetDispatch(tx, row.dispatchId);
    return publicVoiceReservation(await tx.billingVoiceReservation.update({ where: { id: row.id }, data: { state: 'released' } }));
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}
