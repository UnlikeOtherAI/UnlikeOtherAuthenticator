import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { issueSmsQuote } from './billing-sms-quote.service.js';
import { reserveAuthorizedSms } from './billing-sms-reservation.service.js';
import type { SmsNumberDependencies } from './billing-sms-number.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { TelephoneNumber, telephoneDenied, verifyTelephoneServiceAssertion } from './telephone-authority.service.js';
import { CALL_PROOF_PATH } from './telephone-call-proof.service.js';
import { lockTelephoneSmsAuthority, type TelephoneSmsBinding } from './telephone-sms-authority.service.js';

export type TelephoneSmsReserveBody = Omit<TelephoneSmsBinding, 'to'> & {
  number: string; challengeId: string; dispatch_id: string; request_fingerprint: string;
};

export async function reserveTelephoneSms(input: {
  credential: VerifiedBillingAppKey; serviceToken: string; request: TelephoneSmsReserveBody;
}, deps: SmsNumberDependencies) {
  const prisma = deps.prisma ?? getAdminPrisma();
  const body = input.request;
  const number = TelephoneNumber.parse(body.number);
  const assertion = await verifyTelephoneServiceAssertion(input.credential, input.serviceToken,
    `${CALL_PROOF_PATH}/reserve`, 'telephone-call-proof');
  if (assertion.number_digest !== createHash('sha256').update(number).digest('hex')) throw telephoneDenied();
  const binding = { ...body, to: number };
  const authorize = async (tx: Prisma.TransactionClient) => {
    if (assertion.exp <= Math.floor(Date.now() / 1000)) throw telephoneDenied();
    const result = await lockTelephoneSmsAuthority(tx, body.challengeId, input.credential, binding);
    if (result.challenge.callId !== assertion.call_id || result.challenge.organisationId !== assertion.organisation_id
      || result.challenge.teamId !== assertion.team_id) throw telephoneDenied();
    return result;
  };
  const admitted = await runBillingSerializableTransaction(prisma, authorize, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
  const destinationCountry = await deps.provider.destinationCountry(number);
  if (admitted.senderCountry !== destinationCountry) throw telephoneDenied();
  const subject = { product: 'nessie', organisation_id: admitted.challenge.organisationId,
    team_id: admitted.challenge.teamId, user_id: admitted.challenge.userId };
  const prior = await prisma.billingSmsReservation.findUnique({ where: { telephoneCallChallengeId: body.challengeId } });
  const quoteId = prior?.quoteId ?? (await issueSmsQuote({ credential: input.credential, authorize, request: {
    ...subject, country: destinationCountry, number_type: 'mobile', direction: 'outbound',
    destination: number, carrier: null, mcc: null, mnc: null,
  } }, { ...deps, prisma })).id;
  return reserveAuthorizedSms({ credential: input.credential, request: { ...subject,
    dispatch_id: body.dispatch_id, request_fingerprint: body.request_fingerprint, number_id: body.number_id,
    allocation_id: body.allocation_id, account_sid: body.account_sid, from: body.from, to: number,
    quote_id: quoteId, max_segments: body.max_segments, grant_id: null, delegate_id: null,
  } }, { ...deps, prisma }, { telephoneCallChallengeId: body.challengeId, authorize,
    actor: { tv: admitted.challenge.tokenVersion, exp: admitted.challenge.expiresAt.getTime() / 1000 } });
}
