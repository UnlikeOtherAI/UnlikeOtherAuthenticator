import { telephoneRoutingBinding } from './telephone-authority.service.js';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { lockAndAssertGlobalAuthenticationEpoch } from './authentication-epoch.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveTelephoneMatch } from './telephone-match.service.js';
import { lockTelephoneKey, TelephoneNumber, telephoneDenied, telephoneDigest, telephoneLock,
  verifyTelephoneServiceAssertion } from './telephone-authority.service.js';

export const CALL_PROOF_PATH = '/apps/v1/nessie/phone-profile/call-proof';
const refused = (status: 'pending' | 'ambiguous' | 'no_match' | 'invalid' | 'expired' | 'used') =>
  ({ status, authentication: 'none' as const });

/** Caller possession proof belongs only to the authenticated service's exact telephone call. */
export async function telephoneCallProof(input: {
  credential: VerifiedBillingAppKey; serviceToken: string; action: 'start' | 'verify';
  number: string; challengeId?: string; code?: string;
}, deps: { prisma?: PrismaClient; now?: () => Date; generateCode?: () => string } = {}) {
  const number = TelephoneNumber.parse(input.number);
  const assertion = await verifyTelephoneServiceAssertion(input.credential, input.serviceToken,
    `${CALL_PROOF_PATH}/${input.action}`, 'telephone-call-proof');
  if (assertion.number_digest !== createHash('sha256').update(number).digest('hex')) throw telephoneDenied();
  return runInTransaction(deps.prisma ?? getAdminPrisma(), async tx => {
    await lockTelephoneKey(tx, input.credential);
    if (assertion.exp <= Math.floor(Date.now() / 1000)) throw telephoneDenied();
    const binding = telephoneRoutingBinding(assertion, number);
    const lookup = await tx.telephoneLookup.findUnique({ where: {
      appKeyId_callId: { appKeyId: input.credential.id, callId: assertion.call_id },
    } });
    if (!lookup || lookup.requestHash !== binding) throw telephoneDenied();
    const candidate = await resolveTelephoneMatch(tx, assertion, number);
    if (candidate.state !== 'verified') return refused(candidate.state);
    await lockAndAssertGlobalAuthenticationEpoch({ userId: candidate.subject, credentialEpoch: candidate.tokenVersion }, { prisma: tx });
    await telephoneLock(tx, telephoneDigest(number));
    await telephoneLock(tx, `proof:${input.credential.id}:${assertion.call_id}`);
    const now = deps.now?.() ?? new Date();
    if (assertion.exp <= Math.floor(Date.now() / 1000)) throw telephoneDenied();
    const current = await resolveTelephoneMatch(tx, assertion, number);
    if (current.state !== 'verified') return refused(current.state);
    if (current.subject !== candidate.subject || current.tokenVersion !== candidate.tokenVersion) return refused('invalid');

    if (input.action === 'start') {
      const duplicate = await tx.telephoneCallChallenge.findUnique({ where: {
        appKeyId_assertionJti: { appKeyId: input.credential.id, assertionJti: assertion.jti },
      } });
      if (duplicate) throw telephoneDenied();
      const since = new Date(now.getTime() - 15 * 60_000);
      const [person, destination, call] = await Promise.all([
        tx.telephoneCallChallenge.count({ where: { userId: current.subject, createdAt: { gt: since } } }),
        tx.telephoneCallChallenge.count({ where: { number, createdAt: { gt: since } } }),
        tx.telephoneCallChallenge.count({ where: { appKeyId: input.credential.id, callId: assertion.call_id, createdAt: { gt: since } } }),
      ]);
      if (person >= 5 || destination >= 5 || call >= 3) throw new AppError('RATE_LIMITED', 429);
      const id = randomUUID();
      const code = deps.generateCode?.() ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
      const expiresAt = new Date(now.getTime() + 5 * 60_000);
      await tx.telephoneCallChallenge.updateMany({ where: { appKeyId: input.credential.id,
        callId: assertion.call_id, usedAt: null }, data: { usedAt: now } });
      await tx.telephoneCallChallenge.create({ data: {
        id, userId: current.subject, appKeyId: input.credential.id, assertionJti: assertion.jti, callId: assertion.call_id,
        organisationId: assertion.organisation_id, teamId: assertion.team_id, tokenVersion: current.tokenVersion,
        number, numberVerifiedAt: current.verifiedAt, codeHash: telephoneDigest(`call:${id}:${code}`), createdAt: now, expiresAt,
      } });
      return { status: 'challenge' as const, challengeId: id, expiresAt: expiresAt.toISOString(), delivery: { number, code } };
    }

    const challenge = await tx.telephoneCallChallenge.findUnique({ where: { id: input.challengeId ?? '' } });
    if (!challenge || challenge.appKeyId !== input.credential.id || challenge.callId !== assertion.call_id
      || challenge.organisationId !== assertion.organisation_id || challenge.teamId !== assertion.team_id
      || challenge.number !== number) throw telephoneDenied();
    if (challenge.usedAt) return refused('used');
    if (challenge.expiresAt <= now) return refused('expired');
    if (challenge.attempts >= 5 || challenge.userId !== current.subject || challenge.tokenVersion !== current.tokenVersion
      || challenge.numberVerifiedAt.getTime() !== current.verifiedAt.getTime()) return refused('invalid');
    await tx.telephoneCallChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    const actual = Buffer.from(challenge.codeHash);
    const expected = Buffer.from(telephoneDigest(`call:${challenge.id}:${input.code ?? ''}`));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return refused('invalid');
    await tx.telephoneCallChallenge.update({ where: { id: challenge.id }, data: { usedAt: now, verifiedAt: now } });
    return { status: 'verified' as const, authentication: 'telephone_sms' as const, subject: current.subject,
      tokenVersion: current.tokenVersion, organisationId: assertion.organisation_id, teamId: assertion.team_id,
      callId: assertion.call_id, verifiedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString() };
  });
}
