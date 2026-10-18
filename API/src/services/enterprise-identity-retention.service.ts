import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { asPrismaClient } from '../db/tenant-context.js';
import { enterpriseIdentityTupleHash } from './enterprise-identity-status.service.js';
import { revokeEnterpriseUser } from './enterprise-authority-revocation.service.js';
import { parseScimAttributes, SCIM_USER } from './enterprise-scim-protocol.service.js';
import { openEnterpriseSecret } from './enterprise-secret.service.js';

/** ERASE seam: caller holds outbox→product→user locks and will hard-delete this canonical person. */
export async function eraseEnterprisePerson(userId: string, tx: Prisma.TransactionClient | PrismaClient): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { lifecycleStatus: true } });
  if (!user || !['DELETING', 'DELETED'].includes(user.lifecycleStatus)) throw new AppError('FORBIDDEN', 403, 'ENTITY_TERMINAL');
  await revokeEnterpriseUser(asPrismaClient(tx), userId);
  const identities = await tx.externalIdentity.findMany({ where: { userId } });
  const hashes = new Set(identities.map(enterpriseIdentityTupleHash));
  if (identities.length) await tx.externalIdentityTombstone.createMany({ data: identities.map((identity) => ({
    connectionId: identity.connectionId, clientDomain: identity.clientDomain, orgId: identity.orgId,
    tupleHash: enterpriseIdentityTupleHash(identity), reason: 'erased',
  })), skipDuplicates: true });
  const candidates = await tx.orgSsoLinkIntent.findMany({ where: { OR: [
    { candidateUserIds: { has: userId } }, { connectionId: { in: [...new Set(identities.map((identity) => identity.connectionId))] } },
  ] }, select: { id: true, flowId: true, connectionId: true, candidateUserIds: true, identity: true } });
  const eraseLinks: string[] = [];
  for (const candidate of candidates) {
    if (candidate.candidateUserIds.includes(userId)) { eraseLinks.push(candidate.id); continue; }
    const sealed = (candidate.identity as { sealed?: unknown }).sealed;
    if (typeof sealed !== 'string') continue;
    const value = JSON.parse(await openEnterpriseSecret(sealed, `link:${candidate.flowId}`)) as { issuer: string; tenant: string; subject: string };
    if (hashes.has(enterpriseIdentityTupleHash({ ...value, connectionId: candidate.connectionId }))) eraseLinks.push(candidate.id);
  }
  await tx.orgSsoPersonalFactorChallenge.deleteMany({ where: { userId } });
  await tx.orgSsoLinkIntent.deleteMany({ where: { id: { in: eraseLinks } } });
  await tx.orgSsoManagementSession.deleteMany({ where: { userId } });
  await tx.orgSsoManagementIntent.deleteMany({ where: { userId } });
  await tx.enterpriseRecoveryContact.deleteMany({ where: { userId } });
  const resources = await tx.scimResourceLink.findMany({ where: { userId }, select: { id: true, connectionId: true } });
  const resourceIds = new Set(resources.map((row) => row.id));
  const groups = resources.length ? await tx.scimResourceLink.findMany({ where: {
    connectionId: { in: [...new Set(resources.map((row) => row.connectionId))] }, resourceType: 'Groups', deletedAt: null,
  } }) : [];
  const prior = await tx.$queryRaw<Array<{ value: string | null }>>`SELECT current_setting('app.enterprise_identity_erasure',true) AS value`;
  await tx.$executeRaw`SELECT set_config('app.enterprise_identity_erasure','true',true)`;
  try {
    await tx.scimResourceLink.updateMany({ where: { userId }, data: { userId: null, externalId: null, active: false,
      deletedAt: new Date(), attributes: { schemas: [SCIM_USER], active: false }, version: { increment: 1 } } });
    for (const group of groups) {
      const attrs = parseScimAttributes(group.attributes);
      const members = attrs.members?.map((member) => resourceIds.has(member.value) ? { value: member.value } : member);
      if (JSON.stringify(members) !== JSON.stringify(attrs.members)) await tx.scimResourceLink.update({ where: { id: group.id },
        data: { attributes: { ...attrs, members }, version: { increment: 1 } } });
    }
  } finally {
    await tx.$executeRaw`SELECT set_config('app.enterprise_identity_erasure',${prior[0]?.value ?? ''},true)`;
  }
  // Parent FKs remain immutable during life. Erasure removes leaves before their parents.
  for (let depth = 0; depth < 9; depth++) {
    const deleted = await tx.$executeRaw`DELETE FROM session_assurances a WHERE a.user_id=${userId}
      AND NOT EXISTS(SELECT 1 FROM session_assurances child WHERE child.parent_id=a.id)`;
    if (deleted === 0) break;
  }
  if (await tx.sessionAssurance.count({ where: { userId } })) throw new AppError('INTERNAL', 500, 'ASSURANCE_ERASURE_ANCESTRY_INVALID');
  await tx.authenticationEvidence.deleteMany({ where: { userId } });
  await tx.externalIdentity.deleteMany({ where: { userId } });
  await tx.orgSsoGrant.deleteMany({ where: { userId } });
  await tx.membershipContribution.deleteMany({ where: { userId } });
  await tx.membershipSuppression.deleteMany({ where: { userId } });
}

/** RETAIN keeps the canonical deleted identity and stable source references; no mailbox or SCIM resurrection. */
export async function retainEnterprisePerson(userId: string, tx: Prisma.TransactionClient | PrismaClient): Promise<void> {
  await tx.enterpriseRecoveryContact.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.externalIdentity.updateMany({ where: { userId }, data: { status: 'SUSPENDED' } });
  await tx.scimResourceLink.updateMany({ where: { userId }, data: { active: false, version: { increment: 1 } } });
}
