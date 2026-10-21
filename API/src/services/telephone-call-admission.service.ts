import { telephoneRoutingBinding, telephoneOwnerActive } from './telephone-authority.service.js';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { lockAndAssertGlobalAuthenticationEpoch } from './authentication-epoch.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveTelephoneMatch } from './telephone-match.service.js';
import { lockTelephoneKey, TelephoneNumber, telephoneDenied, telephoneDigest, telephoneLock,
  verifyTelephoneServiceAssertion } from './telephone-authority.service.js';

export const CALL_ADMISSION_PATH = '/apps/v1/nessie/phone-profile/call-admission';
const refused = (status: 'pending' | 'ambiguous' | 'no_match' | 'invalid' | 'owner_inactive') => ({ status, authentication: 'none' as const });

/** Explicit lower-assurance caller-ID admission; no current possession or signed-in session claim. */
export async function admitTelephoneCall(input: {
  credential: VerifiedBillingAppKey; serviceToken: string; number: string;
}, deps: { prisma?: PrismaClient } = {}) {
  const number = TelephoneNumber.parse(input.number);
  const assertion = await verifyTelephoneServiceAssertion(input.credential, input.serviceToken,
    CALL_ADMISSION_PATH, 'telephone-routing');
  if (assertion.number_digest !== createHash('sha256').update(number).digest('hex')) throw telephoneDenied();
  return runInTransaction(deps.prisma ?? getAdminPrisma(), async tx => {
    await lockTelephoneKey(tx, input.credential);
    if (assertion.exp <= Math.floor(Date.now() / 1000)) throw telephoneDenied();
    const binding = telephoneRoutingBinding(assertion, number);
    const where = { appKeyId_callId: { appKeyId: input.credential.id, callId: assertion.call_id } };
    const lookup = await tx.telephoneLookup.findUnique({ where });
    if (!lookup || lookup.requestHash !== binding) throw telephoneDenied();
    if (!await telephoneOwnerActive(tx, assertion)) return refused('owner_inactive');
    const owner = assertion.owner_subject === undefined ? {} : { ownerActive: true as const };
    const candidate = await resolveTelephoneMatch(tx, assertion, number);
    if (candidate.state !== 'verified') return { ...refused(candidate.state), ...owner };
    await lockAndAssertGlobalAuthenticationEpoch({ userId: candidate.subject, credentialEpoch: candidate.tokenVersion }, { prisma: tx });
    await telephoneLock(tx, telephoneDigest(number));
    await telephoneLock(tx, `admission:${input.credential.id}:${assertion.call_id}`);
    const current = await resolveTelephoneMatch(tx, assertion, number);
    if (current.state !== 'verified') return { ...refused(current.state), ...owner };
    if (current.subject !== candidate.subject || current.tokenVersion !== candidate.tokenVersion) return { ...refused('invalid'), ...owner };
    const fresh = await tx.telephoneLookup.findUniqueOrThrow({ where });
    if (fresh.admittedSubjectId && (fresh.admittedSubjectId !== current.subject ||
        fresh.admittedTokenVersion !== current.tokenVersion ||
        fresh.admittedNumberVerifiedAt?.getTime() !== current.verifiedAt.getTime())) return { ...refused('invalid'), ...owner };
    const now = new Date();
    if (assertion.exp <= Math.floor(now.getTime() / 1000)) throw telephoneDenied();
    if (!fresh.admittedSubjectId) await tx.telephoneLookup.update({ where, data: {
      admittedSubjectId: current.subject, admittedTokenVersion: current.tokenVersion,
      admittedNumberVerifiedAt: current.verifiedAt, admittedAt: now,
    } });
    return { ...owner, status: 'admitted' as const, authentication: 'registered_caller_id' as const,
      assurance: 'registered_caller_id' as const, possession_verified_this_call: false as const,
      subject: current.subject, tokenVersion: current.tokenVersion, organisationId: assertion.organisation_id,
      teamId: assertion.team_id, callId: assertion.call_id, issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300000).toISOString() };
  });
}
