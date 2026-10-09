import { Prisma, type BillingSmsStandingHold } from '@prisma/client';
import type { BillingSmsStandingHoldRequestV1, BillingSmsStandingReadRequestV1,
  BillingSmsStandingHoldV1, BillingSmsStandingRetireResultV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockSmsCredential, lockSmsSubject, verifySmsActor, assertSmsTeamManager } from './billing-sms-authority.service.js';
import { authorizeBillingCustomerAction, BILLING_CUSTOMER_ACTION } from './billing-customer-action-intent.service.js';
import { readSmsNumber, type SmsNumberDependencies } from './billing-sms-number.service.js';
import { issueSmsQuote } from './billing-sms-quote.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { resolveCreditAccount } from './billing-credit-account.service.js';
import { requireStripeBillingEnabled, resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { smsCreditsToMicrocredits, smsMicrocredits } from './billing-sms-money.service.js';

export function publicSmsStanding(hold: BillingSmsStandingHold): BillingSmsStandingHoldV1 {
  return { id: hold.id, number_id: hold.numberId, allocation_id: hold.allocationId,
    state: hold.state as BillingSmsStandingHoldV1['state'], reserved_credits: smsMicrocredits(hold.reservedMicrocredits) };
}

export async function fundSmsStanding(input: { request: BillingSmsStandingHoldRequestV1;
  actorToken: string; credential: VerifiedBillingAppKey }, deps: SmsNumberDependencies): Promise<BillingSmsStandingHoldV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const body = input.request;
  const added = smsCreditsToMicrocredits(body.reserve_credits);
  const actor = await verifySmsActor({ subject: body, actorToken: input.actorToken, credential: input.credential,
    endpoint: '/billing/v1/sms/inbound/holds' });
  await authorizeBillingCustomerAction({ credential: input.credential, actor,
    organisationId: body.organisation_id, teamId: body.team_id, userId: body.user_id,
    authorityScope: 'TEAM', operation: BILLING_CUSTOMER_ACTION.SMS_INBOUND_FUND, request: body }, { prisma });
  const paid = await readSmsNumber({ product: body.product, resource_id: body.number_id, credential: input.credential }, deps);
  if (!paid.acquisition_authorized || paid.organisation_id !== body.organisation_id || paid.state !== 'active') {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_NUMBER_NOT_ACTIVE');
  }
  const number = await prisma.billingSmsNumberResource.findUniqueOrThrow({ where: { id: body.number_id } });
  const quote = await issueSmsQuote({ credential: input.credential, request: { ...body,
    country: number.country, number_type: 'mobile', direction: 'inbound', destination: null,
    carrier: null, mcc: null, mnc: null,
  }, authorize: (tx) => lockSmsSubject(tx, { subject: body, actor, credential: input.credential }) }, { ...deps, prisma });
  const configured = deps.stripe ? { client: deps.stripe, livemode: deps.stripeLivemode ?? false }
    : requireStripeBillingEnabled();
  const stripe = deps.stripe ?? configured.client;
  const account = await resolveStripeAccountContext(stripe, deps.stripeLivemode ?? configured?.livemode ?? false, prisma);
  const credit = await resolveCreditAccount({ account, organisationId: body.organisation_id, teamId: body.team_id }, { prisma });
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsSubject(tx, { subject: body, actor, credential: input.credential });
    await assertSmsTeamManager(tx, body);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${body.number_id}, 0))::text`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_sms_number_resources WHERE id = ${body.number_id} FOR SHARE`);
    const currentNumber = await tx.billingSmsNumberResource.findFirst({ where: {
      id: body.number_id, serviceId: input.credential.service.id, orgId: body.organisation_id,
      state: 'active', accountSid: deps.provider.configuration.accountSid, phoneNumberSid: number.phoneNumberSid,
    } });
    if (!currentNumber || !currentNumber.phoneNumberSid) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_NUMBER_NOT_ACTIVE');
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sms-inbound:${body.number_id}:${body.allocation_id}`}, 0))::text`);
    if (await tx.billingSmsStandingRetirement.findUnique({ where: { serviceId_numberId_allocationId: {
      serviceId: input.credential.service.id, numberId: body.number_id, allocationId: body.allocation_id,
    } } })) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_STANDING_RETIRED');
    const prior = await tx.billingSmsStandingFunding.findUnique({ where: {
      serviceId_idempotencyKey: { serviceId: input.credential.service.id, idempotencyKey: body.idempotency_key },
    } });
    if (prior) {
      const original = await tx.billingSmsStandingHold.findUniqueOrThrow({ where: { id: prior.holdId } });
      if (original.numberId !== body.number_id || original.allocationId !== body.allocation_id ||
          original.orgId !== body.organisation_id || original.teamId !== body.team_id ||
          prior.addedMicrocredits !== added || prior.requestedByUserId !== body.user_id) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_FUNDING_BINDING_CONFLICT');
      }
      return publicSmsStanding(original);
    }
    let hold = await tx.billingSmsStandingHold.findUnique({ where: { serviceId_numberId_allocationId: {
      serviceId: input.credential.service.id, numberId: body.number_id, allocationId: body.allocation_id,
    } } });
    if (hold && (hold.state !== 'active' || hold.orgId !== body.organisation_id || hold.teamId !== body.team_id ||
        hold.creditAccountId !== credit.id)) throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_STANDING_RETIRED');
    const balance = await lockCreditBalance(tx, credit.id);
    if (balance - await billingReservedMicrocredits(tx, credit.id) < added) {
      throw new AppError('FORBIDDEN', 402, 'BILLING_SMS_INSUFFICIENT_CREDITS');
    }
    if (hold) hold = await tx.billingSmsStandingHold.update({ where: { id: hold.id },
      data: { reservedMicrocredits: hold.reservedMicrocredits + added } });
    else hold = await tx.billingSmsStandingHold.create({ data: { creditAccountId: credit.id,
      serviceId: input.credential.service.id, appKeyId: input.credential.id, orgId: body.organisation_id,
      teamId: body.team_id, numberId: body.number_id, allocationId: body.allocation_id, quoteId: quote.id,
      requestedByUserId: body.user_id, idempotencyKey: body.idempotency_key, reservedMicrocredits: added,
    } });
    await tx.billingSmsStandingFunding.create({ data: { serviceId: input.credential.service.id,
      appKeyId: input.credential.id, holdId: hold.id, quoteId: quote.id,
      idempotencyKey: body.idempotency_key, addedMicrocredits: added, requestedByUserId: body.user_id,
    } });
    return publicSmsStanding(hold);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

export async function readSmsStanding(input: { request: BillingSmsStandingReadRequestV1;
  credential: VerifiedBillingAppKey; retire?: boolean }, deps?: Pick<SmsNumberDependencies, 'prisma'>): Promise<BillingSmsStandingRetireResultV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (input.request.product !== input.credential.service.identifier) throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sms-inbound:${input.request.number_id}:${input.request.allocation_id}`}, 0))::text`);
    const hold = await tx.billingSmsStandingHold.findUnique({ where: { serviceId_numberId_allocationId: {
      serviceId: input.credential.service.id, numberId: input.request.number_id, allocationId: input.request.allocation_id,
    } } });
    if (input.retire) await tx.billingSmsStandingRetirement.upsert({ where: { serviceId_numberId_allocationId: {
      serviceId: input.credential.service.id, numberId: input.request.number_id, allocationId: input.request.allocation_id,
    } }, create: { serviceId: input.credential.service.id, appKeyId: input.credential.id,
      numberId: input.request.number_id, allocationId: input.request.allocation_id }, update: {} });
    if (!hold) {
      if (input.retire) return { number_id: input.request.number_id,
        allocation_id: input.request.allocation_id, state: 'retired', can_fund: false };
      throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_STANDING_NOT_FOUND');
    }
    if (input.retire && hold.state === 'active') return publicSmsStanding(await tx.billingSmsStandingHold.update({
      where: { id: hold.id }, data: { state: 'retired', retiredAt: new Date() },
    }));
    // Retirement retains money for original late inbound receipts; it never refunds unknown usage.
    return publicSmsStanding(hold);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}
