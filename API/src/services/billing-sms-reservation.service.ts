import { Prisma, type BillingSmsReservation } from '@prisma/client';
import type { BillingSmsReserveRequestV1, BillingSmsReservationV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { BillingActor } from './billing-actor.service.js';
import { lockSmsSubject, verifySmsActor } from './billing-sms-authority.service.js';
import { lockSmsGrant } from './billing-sms-grant.service.js';
import { lockSmsQuote, smsMicrocredits, smsProviderUsd, multiplySmsAmount } from './billing-sms-money.service.js';
import { readSmsNumber, type SmsNumberDependencies } from './billing-sms-number.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { resolveCreditAccount } from './billing-credit-account.service.js';
import { requireStripeBillingEnabled, resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { maximumRatedMicrocredits } from './billing-paid-liability.service.js';
import { reserveBudgetDispatch } from './billing-credit-budget-dispatch.service.js';

export function publicSmsReservation(row: BillingSmsReservation, token: string | null = null): BillingSmsReservationV1 {
  return { dispatch_id: row.dispatchId, reservation_id: row.id,
    state: row.state as BillingSmsReservationV1['state'], dispatch_token: token,
    reserved_credits: smsMicrocredits(row.reservedMicrocredits),
    consumed_credits: row.debitedMicrocredits === null ? null : smsMicrocredits(row.debitedMicrocredits),
    message_sid: row.messageSid };
}

export async function lockSmsDispatchAuthority(tx: Prisma.TransactionClient, row: BillingSmsReservation,
  credential: VerifiedBillingAppKey): Promise<void> {
  if (row.serviceId !== credential.service.id) throw new AppError('NOT_FOUND', 404);
  if (row.grantId) {
    const grant = await lockSmsGrant(tx, { grantId: row.grantId, product: credential.service.identifier, credential });
    if (grant.numberId !== row.numberId || grant.allocationId !== row.allocationId ||
        grant.delegateId !== row.delegateId || grant.maxSegments < row.maxSegments ||
        grant.orgId !== row.orgId || grant.teamId !== row.teamId || grant.userId !== row.userId) {
      throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_GRANT_BINDING_CONFLICT');
    }
  } else {
    await lockSmsSubject(tx, { subject: { product: credential.service.identifier,
      organisation_id: row.orgId, team_id: row.teamId, user_id: row.userId },
    actor: { tv: row.actorTokenVersion, exp: row.actorExpiresAt.getTime() / 1000 }, credential });
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_app_keys WHERE id = ${row.appKeyId} FOR SHARE`);
    const key = await tx.billingAppKey.findFirst({ where: { id: row.appKeyId, serviceId: row.serviceId,
      purpose: 'ENTITLEMENT', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    }, select: { id: true } });
    if (!key) throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_CREDENTIAL_REVOKED');
  }
}

export async function reserveSms(input: { request: BillingSmsReserveRequestV1; actorToken?: string;
  credential: VerifiedBillingAppKey }, deps: SmsNumberDependencies): Promise<BillingSmsReservationV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const body = input.request;
  const delegated = body.grant_id !== null && body.delegate_id !== null;
  if ((body.grant_id === null) !== (body.delegate_id === null) ||
      input.credential.purpose !== (delegated ? 'SMS_RUNTIME' : 'ENTITLEMENT') ||
      body.product !== input.credential.service.identifier) throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_RESERVE_AUTHORITY_INVALID');
  let actor: Pick<BillingActor, 'tv' | 'exp'>;
  if (delegated && body.grant_id !== null) {
    const grant = await prisma.billingSmsDispatchGrant.findUnique({ where: { id: body.grant_id } });
    if (!grant || grant.serviceId !== input.credential.service.id || grant.orgId !== body.organisation_id ||
        grant.teamId !== body.team_id || grant.userId !== body.user_id || grant.numberId !== body.number_id ||
        grant.allocationId !== body.allocation_id || grant.delegateId !== body.delegate_id ||
        body.max_segments > grant.maxSegments) throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_GRANT_BINDING_CONFLICT');
    actor = { tv: grant.actorTokenVersion, exp: 0 };
  } else {
    actor = await verifySmsActor({ subject: body, actorToken: input.actorToken ?? '', credential: input.credential,
      endpoint: '/billing/v1/sms/reservations' });
  }
  const paid = await readSmsNumber({ product: body.product, resource_id: body.number_id, credential: input.credential }, deps);
  if (paid.organisation_id !== body.organisation_id || paid.phone_number !== body.from || !paid.acquisition_authorized) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_PAYMENT_NOT_ACTIVE');
  }
  if (body.account_sid !== deps.provider.configuration.accountSid) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_ROUTE_INVALID');
  }
  const destinationCountry = await deps.provider.destinationCountry(body.to);
  const configured = deps.stripe ? { client: deps.stripe, livemode: deps.stripeLivemode ?? false }
    : requireStripeBillingEnabled();
  const stripe = deps.stripe ?? configured.client;
  const account = await resolveStripeAccountContext(stripe, deps.stripeLivemode ?? configured?.livemode ?? false, prisma);
  const credits = await resolveCreditAccount({ account, organisationId: body.organisation_id, teamId: body.team_id }, { prisma });
  return runBillingSerializableTransaction(prisma, async (tx) => {
    if (delegated && body.grant_id !== null) await lockSmsGrant(tx, { grantId: body.grant_id, product: body.product, credential: input.credential });
    else await lockSmsSubject(tx, { subject: body, actor, credential: input.credential });
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${body.number_id}, 0))::text`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_sms_number_resources WHERE id = ${body.number_id} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${body.dispatch_id}, 0))::text`);
    if (await tx.billingSmsDispatchCancellation.findUnique({ where: { dispatchId: body.dispatch_id } })) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_DISPATCH_CANCELED');
    }
    const prior = await tx.billingSmsReservation.findUnique({ where: { dispatchId: body.dispatch_id } });
    if (prior) {
      if (prior.requestFingerprint !== body.request_fingerprint || prior.serviceId !== input.credential.service.id ||
          prior.orgId !== body.organisation_id || prior.teamId !== body.team_id || prior.userId !== body.user_id ||
          prior.numberId !== body.number_id || prior.allocationId !== body.allocation_id ||
          prior.quoteId !== body.quote_id || prior.grantId !== body.grant_id || prior.delegateId !== body.delegate_id ||
          prior.accountSid !== body.account_sid || prior.from !== body.from || prior.to !== body.to ||
          prior.maxSegments !== body.max_segments) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_DISPATCH_BINDING_CONFLICT');
      return publicSmsReservation(prior);
    }
    const number = await tx.billingSmsNumberResource.findFirst({ where: { id: body.number_id,
      serviceId: input.credential.service.id, orgId: body.organisation_id, state: 'active',
      accountSid: body.account_sid, phoneNumber: body.from, phoneNumberSid: { not: null } } });
    if (!number) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_NUMBER_NOT_ACTIVE');
    const now = deps.now?.() ?? new Date();
    const evidence = await lockSmsQuote(tx, { quoteId: body.quote_id, serviceId: input.credential.service.id,
      orgId: body.organisation_id, direction: 'outbound', destination: body.to, accountSid: body.account_sid, now });
    if (evidence.quote.country !== destinationCountry) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_DESTINATION_COUNTRY_MISMATCH');
    if (!evidence.quote.providerBoundAmount) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_ROUTE_BOUND_UNAVAILABLE');
    const one = smsProviderUsd(evidence.quote.providerBoundAmount.toFixed(),
      evidence.quote.providerCurrency, evidence.usdPerEur);
    const raw = multiplySmsAmount(one.toFixed(), body.max_segments);
    const held = maximumRatedMicrocredits(raw, evidence.quote.messageMarkupBps);
    const month = now.toISOString().slice(0, 7);
    await reserveBudgetDispatch(tx, { dispatchId: body.dispatch_id, requestFingerprint: body.request_fingerprint,
      startedAt: now, product: body.product, serviceId: input.credential.service.id, providerServiceId: 'twilio-sms',
      orgId: body.organisation_id, teamId: body.team_id, userId: body.user_id, billingMonth: month,
      currency: 'USD', tariffId: `sms-quote:${body.quote_id}`, tariffMode: 'STANDARD', markupBps: evidence.quote.messageMarkupBps,
      paymentMode: 'PREPAID', rawCostBound: raw, context: null });
    const balance = await lockCreditBalance(tx, credits.id);
    if (balance - await billingReservedMicrocredits(tx, credits.id) < held) {
      throw new AppError('FORBIDDEN', 402, 'BILLING_SMS_INSUFFICIENT_CREDITS');
    }
    return publicSmsReservation(await tx.billingSmsReservation.create({ data: {
      dispatchId: body.dispatch_id, requestFingerprint: body.request_fingerprint, creditAccountId: credits.id,
      serviceId: input.credential.service.id, appKeyId: input.credential.id, orgId: body.organisation_id,
      teamId: body.team_id, userId: body.user_id, actorTokenVersion: actor.tv,
      actorExpiresAt: new Date(actor.exp * 1000), numberId: body.number_id, allocationId: body.allocation_id,
      quoteId: body.quote_id, grantId: body.grant_id, delegateId: body.delegate_id,
      accountSid: body.account_sid, from: body.from, to: body.to, maxSegments: body.max_segments,
      reservedMicrocredits: held, billingMonth: month,
    } }));
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED', { timeoutMs: 30_000 });
}
