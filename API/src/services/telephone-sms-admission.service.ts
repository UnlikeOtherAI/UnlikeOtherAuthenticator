import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { lockAndAssertGlobalAuthenticationEpoch } from './authentication-epoch.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveTelephoneMatch } from './telephone-match.service.js';
import { lockTelephoneKey, TelephoneNumber, telephoneDenied, telephoneDigest, telephoneLock,
  verifyTelephoneSmsAssertion, telephoneOwnerActive } from './telephone-authority.service.js';

const refused = (status: string) => ({ status, authentication: 'none' as const });
/** SMS eligibility only; neither historic possession nor a signed webhook creates a user session. */
export async function admitTelephoneSms(input: {
  credential: VerifiedBillingAppKey; serviceToken: string; number: string;
}, deps: { prisma?: PrismaClient } = {}) {
  const number = TelephoneNumber.parse(input.number);
  const assertion = await verifyTelephoneSmsAssertion(input.credential, input.serviceToken);
  if (assertion.number_digest !== createHash('sha256').update(number).digest('hex')) throw telephoneDenied();
  const messageSid = `SM${assertion.message_sid.slice(2).toLowerCase()}`;
  const accountSid = `AC${assertion.account_sid.slice(2).toLowerCase()}`;
  return runInTransaction(deps.prisma ?? getAdminPrisma(), async tx => {
    await lockTelephoneKey(tx, input.credential);
    await telephoneLock(tx, `sms-admission:${input.credential.id}`);
    const binding = telephoneDigest(JSON.stringify([assertion.organisation_id, assertion.team_id, accountSid, number, assertion.owner_subject ?? null]));
    const where = { appKeyId_messageSid: { appKeyId: input.credential.id, messageSid } };
    const prior = await tx.telephoneSmsAdmission.findUnique({ where });
    if (prior && prior.requestHash !== binding) throw telephoneDenied();
    const now = new Date();
    if (assertion.exp <= Math.floor(now.getTime() / 1000)) throw telephoneDenied();
    if (!prior && await tx.telephoneSmsAdmission.count({ where: { appKeyId: input.credential.id,
      createdAt: { gt: new Date(now.getTime() - 60000) } } }) >= 120) throw new AppError('RATE_LIMITED', 429, 'RATE_LIMITED');
    const activeOwner = await telephoneOwnerActive(tx, assertion);
    const owner = assertion.owner_subject === undefined ? {} : { ownerActive: true as const };
    if (!activeOwner) {
      if (!prior) await tx.telephoneSmsAdmission.create({ data: { ...where.appKeyId_messageSid,
        requestHash: binding, status: 'owner_inactive' } });
      return refused('owner_inactive');
    }
    // An originally ineligible message cannot acquire a person after later enrollment.
    if (prior && prior.status !== 'admitted') return { ...refused(prior.status), ...owner };
    const candidate = await resolveTelephoneMatch(tx, assertion, number);
    if (candidate.state === 'verified') {
      await lockAndAssertGlobalAuthenticationEpoch({ userId: candidate.subject, credentialEpoch: candidate.tokenVersion }, { prisma: tx });
      await telephoneLock(tx, telephoneDigest(number));
    }
    const current = await resolveTelephoneMatch(tx, assertion, number);
    let status: 'admitted' | 'pending' | 'ambiguous' | 'no_match' | 'invalid' = current.state === 'verified' ? 'admitted' : current.state;
    if (current.state === 'verified' && (candidate.state !== 'verified' || candidate.subject !== current.subject
      || candidate.tokenVersion !== current.tokenVersion || (prior && (prior.subjectId !== current.subject
      || prior.tokenVersion !== current.tokenVersion || prior.numberVerifiedAt?.getTime() !== current.verifiedAt.getTime())))) status = 'invalid';
    if (assertion.exp <= Math.floor(Date.now() / 1000)) throw telephoneDenied();
    if (!prior) await tx.telephoneSmsAdmission.create({ data: { ...where.appKeyId_messageSid, requestHash: binding, status,
      ...(status === 'admitted' && current.state === 'verified' ? { subjectId: current.subject,
        tokenVersion: current.tokenVersion, numberVerifiedAt: current.verifiedAt } : {}) } });
    if (status !== 'admitted' || current.state !== 'verified') return { ...refused(status), ...owner };
    return { ...owner, status: 'admitted' as const, authentication: 'none' as const, eligibility: 'verified_team_number' as const,
      subject: current.subject, tokenVersion: current.tokenVersion, organisationId: assertion.organisation_id,
      teamId: assertion.team_id, accountSid, messageSid, issuedAt: now.toISOString(),
      expiresAt: new Date(Math.min(now.getTime() + 60000, assertion.exp * 1000)).toISOString() };
  });
}
