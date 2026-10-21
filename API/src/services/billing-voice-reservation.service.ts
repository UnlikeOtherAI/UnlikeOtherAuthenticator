import { createHash } from 'node:crypto';
import { Prisma, type BillingVoiceReservation } from '@prisma/client';
import type { BillingVoiceReserveRequestV1, BillingVoiceReservationV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { assertVoiceNumber, assertVoiceRoute, type VoiceDependencies } from './billing-voice-quote.service.js';
import { lockVoiceGrant } from './billing-voice-grant.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { resolveCreditAccount } from './billing-credit-account.service.js';
import { requireStripeBillingEnabled, resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { reserveBudgetDispatch } from './billing-credit-budget-dispatch.service.js';
import { smsMicrocredits } from './billing-sms-money.service.js';

export function publicVoiceReservation(row: BillingVoiceReservation, token: string | null = null): BillingVoiceReservationV1 {
  return { reservation_id: row.id, dispatch_id: row.dispatchId, state: row.state as BillingVoiceReservationV1['state'],
    dispatch_token: token, reserved_credits: smsMicrocredits(row.reservedMicrocredits),
    consumed_credits: row.debitedMicrocredits === null ? null : smsMicrocredits(row.debitedMicrocredits),
    call_sid: row.callSid, max_duration_seconds: row.maxDurationSeconds, claim_expires_at: row.claimExpiresAt.toISOString() };
}
export async function lockVoiceDispatch(tx: Prisma.TransactionClient, dispatchId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`voice:${dispatchId}`}, 0))::text`);
}
export async function reserveVoice(input: { request: BillingVoiceReserveRequestV1; credential: VerifiedBillingAppKey },
  deps: VoiceDependencies): Promise<BillingVoiceReservationV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const body = input.request;
  if (input.credential.purpose !== 'VOICE_RUNTIME') throw new AppError('FORBIDDEN', 403);
  const grant = await runBillingSerializableTransaction(prisma, tx => lockVoiceGrant(tx, {
    grantId: body.grant_id, product: body.product, credential: input.credential,
  }), 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
  assertVoiceRoute(grant, body);
  const bindingDigest = createHash('sha256').update(JSON.stringify(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const existing = await prisma.billingVoiceReservation.findUnique({ where: { dispatchId: body.dispatch_id } });
  if (existing) {
    if (existing.serviceId !== input.credential.service.id || existing.bindingDigest !== bindingDigest) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_BINDING_CONFLICT');
    }
    return publicVoiceReservation(existing);
  }

  if ((grant.direction === 'inbound') !== (body.call_sid !== null) ||
      (grant.purpose === 'human_transfer') !== (body.parent_reservation_id !== null)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_VOICE_LEG_BINDING_INVALID');
  }
  const accountSid = await assertVoiceNumber(grant, body, input.credential, deps);
  if (body.call_sid) {
    const inbound = await deps.voice.receipt({ accountSid, from: body.from, to: body.to, direction: 'inbound' }, body.call_sid);
    // Admission happens before answering, so an already-started/terminal call is not a fresh prepaid call.
    if (inbound.terminal || inbound.startedAt) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_ALREADY_STARTED');
  }
  const configured = deps.stripe ? { client: deps.stripe, livemode: deps.stripeLivemode ?? false } : requireStripeBillingEnabled();
  const account = await resolveStripeAccountContext(configured.client, configured.livemode, prisma);
  const credits = await resolveCreditAccount({ account, organisationId: grant.orgId, teamId: grant.teamId }, { prisma });

  return runBillingSerializableTransaction(prisma, async tx => {
    await lockVoiceGrant(tx, { grantId: grant.id, product: body.product, credential: input.credential });
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`voice-grant:${grant.id}`}, 0))::text`);
    await lockVoiceDispatch(tx, body.dispatch_id);
    const prior = await tx.billingVoiceReservation.findUnique({ where: { dispatchId: body.dispatch_id } });
    if (prior) {
      if (prior.serviceId !== input.credential.service.id || prior.bindingDigest !== bindingDigest) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_BINDING_CONFLICT');
      }
      return publicVoiceReservation(prior);
    }
    const now = deps.now?.() ?? new Date();
    const quote = await tx.billingVoiceQuote.findUnique({ where: { id: body.quote_id } });
    if (!quote || quote.serviceId !== input.credential.service.id || quote.grantId !== grant.id ||
        quote.from !== body.from || quote.to !== body.to || quote.accountSid !== accountSid ||
        quote.direction !== grant.direction || quote.maxDurationSeconds !== body.max_duration_seconds || quote.expiresAt <= now) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_QUOTE_INVALID');
    }
    const number = await tx.billingSmsNumberResource.findFirst({ where: { id: grant.numberId, state: 'active',
      accountSid, serviceId: input.credential.service.id, orgId: grant.orgId } });
    if (!number) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_NUMBER_NOT_ACTIVE');
    if (body.parent_reservation_id) {
      const parent = await tx.billingVoiceReservation.findUnique({ where: { id: body.parent_reservation_id } });
      if (!parent || parent.serviceId !== input.credential.service.id || parent.orgId !== grant.orgId ||
          parent.teamId !== grant.teamId || parent.numberId !== grant.numberId || parent.allocationId !== grant.allocationId ||
          parent.conversationId !== body.conversation_id || !parent.callSid || parent.state !== 'dispatching') {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_PARENT_INVALID');
      }
    }
    const active = await tx.billingVoiceReservation.count({ where: { grantId: grant.id,
      state: { in: ['reserved', 'dispatching', 'uncertain', 'reconciliation'] } } });
    if (active >= grant.maxConcurrentCalls) throw new AppError('FORBIDDEN', 429, 'BILLING_VOICE_CONCURRENCY_LIMIT');
    const month = now.toISOString().slice(0, 7);
    await reserveBudgetDispatch(tx, { dispatchId: body.dispatch_id, requestFingerprint: body.request_fingerprint,
      startedAt: now, product: body.product, serviceId: input.credential.service.id, providerServiceId: 'twilio-voice',
      orgId: grant.orgId, teamId: grant.teamId, userId: grant.userId, billingMonth: month,
      currency: 'USD', tariffId: `voice-quote:${quote.id}`, tariffMode: 'STANDARD', markupBps: quote.markupBps,
      paymentMode: 'PREPAID', rawCostBound: quote.rawCostBound, context: null });
    const balance = await lockCreditBalance(tx, credits.id);
    if (balance - await billingReservedMicrocredits(tx, credits.id) < quote.reservedMicrocredits) {
      throw new AppError('FORBIDDEN', 402, 'BILLING_VOICE_INSUFFICIENT_CREDITS');
    }
    return publicVoiceReservation(await tx.billingVoiceReservation.create({ data: {
      dispatchId: body.dispatch_id, requestFingerprint: body.request_fingerprint, bindingDigest,
      serviceId: input.credential.service.id, appKeyId: input.credential.id, orgId: grant.orgId,
      teamId: grant.teamId, userId: grant.userId, creditAccountId: credits.id, grantId: grant.id, quoteId: quote.id,
      numberId: grant.numberId, allocationId: grant.allocationId, accountSid, from: body.from, to: body.to,
      direction: grant.direction, conversationId: body.conversation_id, legId: body.leg_id,
      parentReservationId: body.parent_reservation_id, maxDurationSeconds: body.max_duration_seconds,
      callSid: body.call_sid, reservedMicrocredits: quote.reservedMicrocredits, claimExpiresAt: quote.expiresAt,
      billingMonth: month,
    } }));
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED', { timeoutMs: 30000 });
}
