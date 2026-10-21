import { Prisma, type BillingVoiceGrant } from '@prisma/client';
import type { BillingVoiceQuoteRequestV1, BillingVoiceQuoteV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockVoiceGrant } from './billing-voice-grant.service.js';
import { BillingVoiceProvider } from './billing-voice-provider.service.js';
import { configuredVoicePolicy, type VoicePolicy, voicePolicySchema } from './billing-voice-policy.service.js';
import { configuredSmsProvider } from './billing-sms-runtime.service.js';
import { readSmsNumber, type SmsNumberDependencies } from './billing-sms-number.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { maximumRatedMicrocredits } from './billing-paid-liability.service.js';
import { smsMicrocredits } from './billing-sms-money.service.js';

export type VoiceDependencies = SmsNumberDependencies & { voice: BillingVoiceProvider; policy: VoicePolicy };
export function configuredVoiceDependencies(): VoiceDependencies {
  const provider = configuredSmsProvider();
  return { provider, voice: new BillingVoiceProvider(provider.configuration), policy: configuredVoicePolicy() };
}
export function assertVoiceRoute(grant: BillingVoiceGrant, body: BillingVoiceQuoteRequestV1): void {
  if (grant.delegateId !== body.delegate_id || body.max_duration_seconds > grant.maxDurationSeconds ||
      (grant.direction === 'outbound' && !grant.destinations.includes(body.to))) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_VOICE_GRANT_BINDING_CONFLICT');
  }
}
export async function assertVoiceNumber(grant: BillingVoiceGrant, body: Pick<BillingVoiceQuoteRequestV1, 'from' | 'to'>,
  credential: VerifiedBillingAppKey, deps: VoiceDependencies): Promise<string> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const paid = await readSmsNumber({ product: credential.service.identifier, resource_id: grant.numberId, credential }, deps);
  const local = grant.direction === 'inbound' ? body.to : body.from;
  if (!paid.acquisition_authorized || paid.organisation_id !== grant.orgId || paid.phone_number !== local) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_VOICE_NUMBER_NOT_ACTIVE');
  }
  const number = await prisma.billingSmsNumberResource.findUnique({ where: { id: grant.numberId } });
  if (!number?.phoneNumberSid || !number.accountSid || number.state !== 'active') {
    throw new AppError('FORBIDDEN', 403, 'BILLING_VOICE_NUMBER_NOT_ACTIVE');
  }
  await deps.voice.ownedNumber(number.accountSid, number.phoneNumberSid, local);
  return number.accountSid;
}
export async function issueVoiceQuote(input: { request: BillingVoiceQuoteRequestV1; credential: VerifiedBillingAppKey },
  deps: VoiceDependencies): Promise<BillingVoiceQuoteV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const body = input.request;
  if (input.credential.purpose !== 'VOICE_RUNTIME') throw new AppError('FORBIDDEN', 403);
  const grant = await runBillingSerializableTransaction(prisma, tx => lockVoiceGrant(tx, {
    grantId: body.grant_id, product: body.product, credential: input.credential,
  }), 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
  assertVoiceRoute(grant, body);
  const accountSid = await assertVoiceNumber(grant, body, input.credential, deps);
  const now = deps.now?.() ?? new Date();
  const policy = voicePolicySchema.parse(deps.policy);
  if (policy.accountSid !== accountSid || policy.region !== (deps.voice.configuration.region ?? 'us1') ||
      Date.parse(policy.expiresAt) <= now.getTime() || body.max_duration_seconds > policy.maxDurationSeconds) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_VOICE_EVIDENCE_UNAVAILABLE');
  }
  const evidence = await deps.voice.price({ accountSid, from: body.from, to: body.to,
    direction: grant.direction as 'inbound' | 'outbound' });
  const seconds = Math.max(policy.minimumBilledSeconds,
    Math.ceil(body.max_duration_seconds / policy.billingIncrementSeconds) * policy.billingIncrementSeconds);
  // Round upward at the stored decimal precision so division cannot reduce the authorized bound.
  const raw = new Prisma.Decimal(evidence.amount).mul(seconds).div(60).toDecimalPlaces(18, Prisma.Decimal.ROUND_CEIL);
  const held = maximumRatedMicrocredits(raw, policy.markupBps);
  const expiresAt = new Date(Math.min(now.getTime() + 60000, Date.parse(policy.expiresAt)));
  const quote = await runBillingSerializableTransaction(prisma, async tx => {
    await lockVoiceGrant(tx, { grantId: grant.id, product: body.product, credential: input.credential });
    return tx.billingVoiceQuote.create({ data: { serviceId: input.credential.service.id, grantId: grant.id,
      accountSid, from: body.from, to: body.to, direction: grant.direction, maxDurationSeconds: body.max_duration_seconds,
      rawCostBound: raw, markupBps: policy.markupBps, reservedMicrocredits: held,
      providerEvidence: { ...evidence, observedAt: now.toISOString() }, policyEvidence: policy, expiresAt } });
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
  return { id: quote.id, grant_id: grant.id, from: quote.from, to: quote.to,
    direction: quote.direction as 'inbound' | 'outbound', max_duration_seconds: quote.maxDurationSeconds,
    reserved_credits: smsMicrocredits(held), expires_at: expiresAt.toISOString() };
}
