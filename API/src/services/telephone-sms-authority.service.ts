import { Prisma, type PrismaClient } from '@prisma/client';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockAndAssertGlobalAuthenticationEpoch } from './authentication-epoch.service.js';
import { lockSmsCredential } from './billing-sms-authority.service.js';
import { assertActivePrepaidSubject } from './billing-prepaid-authority.service.js';
import { telephoneDenied, telephoneDigest, telephoneLock } from './telephone-authority.service.js';
import { resolveTelephoneMatch } from './telephone-match.service.js';

export type TelephoneSmsBinding = {
  number_id: string; allocation_id: string; account_sid: string; from: string; to: string; max_segments: number;
};

/** The challenge authorizes exactly its OTP delivery, never arbitrary service SMS. */
export async function lockTelephoneSmsAuthority(tx: Prisma.TransactionClient, challengeId: string,
  credential: VerifiedBillingAppKey, binding: TelephoneSmsBinding) {
  if (credential.service.identifier !== 'nessie' || !['CUSTOMER_LIFECYCLE', 'SMS_RUNTIME'].includes(credential.purpose)) throw telephoneDenied();
  const challenge = await tx.telephoneCallChallenge.findUnique({ where: { id: challengeId } });
  if (!challenge || challenge.number !== binding.to || !Number.isInteger(binding.max_segments)
    || binding.max_segments < 1 || binding.max_segments > 3) throw telephoneDenied();
  await lockAndAssertGlobalAuthenticationEpoch({ userId: challenge.userId, credentialEpoch: challenge.tokenVersion }, { prisma: tx });
  await lockSmsCredential(tx, credential);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_app_keys WHERE id = ${challenge.appKeyId} FOR SHARE`);
  const originalKey = await tx.billingAppKey.findFirst({ where: {
    id: challenge.appKeyId, serviceId: credential.service.id, purpose: 'CUSTOMER_LIFECYCLE', revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], service: { active: true },
  }, select: { id: true } });
  if (!originalKey || (credential.purpose === 'CUSTOMER_LIFECYCLE' && credential.id !== originalKey.id)) throw telephoneDenied();
  await telephoneLock(tx as PrismaClient, telephoneDigest(challenge.number));
  const live = await tx.telephoneCallChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
  if (live.usedAt || live.expiresAt <= new Date() || live.attempts >= 5) throw telephoneDenied();
  const match = await resolveTelephoneMatch(tx as PrismaClient,
    { organisation_id: live.organisationId, team_id: live.teamId }, live.number);
  if (match.state !== 'verified' || match.subject !== live.userId || match.tokenVersion !== live.tokenVersion
    || match.verifiedAt.getTime() !== live.numberVerifiedAt.getTime()) throw telephoneDenied();
  await assertActivePrepaidSubject(tx, { userId: live.userId, organisationId: live.organisationId, teamId: live.teamId }, live.tokenVersion);
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${binding.number_id}, 0))::text`);
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sms-inbound:${binding.number_id}:${binding.allocation_id}`}, 0))::text`);
  const [number, hold, retired] = await Promise.all([
    tx.billingSmsNumberResource.findFirst({ where: { id: binding.number_id, serviceId: credential.service.id,
      orgId: live.organisationId, accountSid: binding.account_sid, phoneNumber: binding.from,
      phoneNumberSid: { not: null }, state: 'active' } }),
    tx.billingSmsStandingHold.findFirst({ where: { serviceId: credential.service.id, orgId: live.organisationId,
      teamId: live.teamId, numberId: binding.number_id, allocationId: binding.allocation_id,
      state: 'active', retiredAt: null, reservedMicrocredits: { gt: 0n } } }),
    tx.billingSmsStandingRetirement.findUnique({ where: { serviceId_numberId_allocationId: {
      serviceId: credential.service.id, numberId: binding.number_id, allocationId: binding.allocation_id } } }),
  ]);
  if (!number || !hold || retired) throw telephoneDenied();
  return { challenge: live, senderCountry: number.country };
}
