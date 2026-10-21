import { telephoneRoutingBinding } from './telephone-authority.service.js';
import { resolveTelephoneMatch } from './telephone-match.service.js';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { TelephoneNumber, lockTelephoneKey, telephoneDenied,
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
    const binding = telephoneRoutingBinding(assertion, number);
    const where = { appKeyId_callId: { appKeyId: input.credential.id, callId: assertion.call_id } };
    const prior = await tx.telephoneLookup.findUnique({ where });
    if (prior && prior.requestHash !== binding) throw telephoneDenied();
    if (!prior && await tx.telephoneLookup.count({ where: { appKeyId: input.credential.id,
      createdAt: { gt: new Date(now.getTime() - 60_000) } } }) >= 120) {
      throw new AppError('RATE_LIMITED', 429, 'RATE_LIMITED');
    }
    const candidate = await resolveTelephoneMatch(tx, assertion, number);
    const match = candidate.state === 'no_match' ? null : candidate.state === 'verified'
      ? { state: candidate.state, subject: candidate.subject, verifiedAt: candidate.verifiedAt.toISOString() }
      : { state: candidate.state };
    await tx.telephoneLookup.upsert({ where,
      create: { ...where.appKeyId_callId, requestHash: binding, matched: Boolean(match) },
      update: { matched: Boolean(match) } });
    return { match, authentication: 'none' as const };
  });
}
