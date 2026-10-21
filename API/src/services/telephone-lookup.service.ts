import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { TelephoneNumber, lockTelephoneKey, telephoneDenied, telephoneDigest,
  telephoneLock, verifyTelephoneLookupAssertion } from './telephone-authority.service.js';

export async function lookupTelephone(input: {
  credential: VerifiedBillingAppKey; serviceToken: string; number: string;
}, deps: { prisma?: PrismaClient } = {}) {
  const number = TelephoneNumber.parse(input.number);
  const assertion = await verifyTelephoneLookupAssertion(input.credential, input.serviceToken);
  // SHA-256 here is a request binding signed by Nessie, never a stored phone-number index.
  if (assertion.number_digest !== createHash('sha256').update(number).digest('hex')) throw telephoneDenied();
  return runInTransaction(deps.prisma ?? getAdminPrisma(), async tx => {
    await lockTelephoneKey(tx, input.credential);
    await telephoneLock(tx, `lookup:${input.credential.id}`);
    const now = new Date();
    if (assertion.exp <= Math.floor(now.getTime() / 1000)) throw telephoneDenied();
    const binding = telephoneDigest(JSON.stringify([assertion.organisation_id, assertion.team_id, number]));
    const where = { appKeyId_callId: { appKeyId: input.credential.id, callId: assertion.call_id } };
    const prior = await tx.telephoneLookup.findUnique({ where });
    if (prior && prior.requestHash !== binding) throw telephoneDenied();
    if (!prior && await tx.telephoneLookup.count({ where: { appKeyId: input.credential.id,
      createdAt: { gt: new Date(now.getTime() - 60_000) } } }) >= 120) {
      throw new AppError('RATE_LIMITED', 429, 'RATE_LIMITED');
    }
    const phones = await tx.userTelephone.findMany({ where: { OR: [{ number }, { pendingNumber: number }],
      user: { lifecycleStatus: 'ACTIVE', orgMembers: { some: { orgId: assertion.organisation_id, status: 'ACTIVE',
        org: { lifecycleStatus: 'ACTIVE' } } }, teamMembers: { some: { teamId: assertion.team_id, status: 'ACTIVE',
        team: { orgId: assertion.organisation_id, lifecycleStatus: 'ACTIVE' } } } } },
      select: { userId: true, number: true, verifiedAt: true }, take: 2 });
    const phone = phones[0];
    const match = phones.length > 1 ? { state: 'ambiguous' as const }
      : !phone ? null : phone.number === number && phone.verifiedAt
        ? { state: 'verified' as const, subject: phone.userId, verifiedAt: phone.verifiedAt.toISOString() }
        : { state: 'pending' as const };
    await tx.telephoneLookup.upsert({ where,
      create: { ...where.appKeyId_callId, requestHash: binding, matched: Boolean(match) },
      update: { matched: Boolean(match) } });
    return { match, authentication: 'none' as const };
  });
}
