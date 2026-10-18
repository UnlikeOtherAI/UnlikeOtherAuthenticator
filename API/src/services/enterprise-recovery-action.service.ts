import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { lockEnterpriseScope } from './org-sso-management.service.js';
import { lockEnterpriseOutbox, revokeEnterpriseScope } from './org-sso-revocation.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { verifyTwoFactorForLogin } from './twofactor-login.service.js';
import { lockAndWithdrawConnectionMemberships } from './membership-provenance.service.js';

type Purpose = 'confirm' | 'drill' | 'recover';
function denied(): never { throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED'); }
async function liveContact(id: string, tx: Prisma.TransactionClient) {
  const contact = await tx.enterpriseRecoveryContact.findUnique({ where: { id } });
  if (!contact || contact.revokedAt || (!contact.confirmedAt && contact.createdAt.getTime() + 7 * 86400000 <= Date.now())) denied();
  const scope = { clientDomain: contact.clientDomain, orgId: contact.orgId };
  const [person, policy, org, client, member] = await Promise.all([
    tx.user.findUnique({ where: { id: contact.userId } }),
    tx.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: scope } }),
    tx.organisation.findUnique({ where: { id: contact.orgId } }),
    tx.clientDomain.findUnique({ where: { domain: contact.clientDomain } }),
    tx.orgMember.findUnique({ where: { orgId_userId: { orgId: contact.orgId, userId: contact.userId } } }),
  ]);
  if (!person || person.lifecycleStatus !== 'ACTIVE' || !person.twoFaEnabled || !person.twoFaSecret ||
    person.tokenVersion !== contact.credentialEpoch || hashAssuranceReference(person.twoFaSecret) !== contact.factorHash ||
    !policy || policy.recoveryRevision !== contact.policyRevision || org?.lifecycleStatus !== 'ACTIVE' ||
    client?.status !== 'active' || member?.status !== 'ACTIVE') denied();
  return { contact, policy, org };
}

/** The opaque address handle starts a challenge; it never authorizes an action. */
export async function startRecoveryChallenge(input: { contact: string; purpose: Purpose; browser: string }) {
  return getAdminPrisma().$transaction(async (tx) => {
    const row = await tx.enterpriseRecoveryContact.findUnique({ where: { handleHash: hashAssuranceReference(input.contact) } });
    if (!row) denied();
    const { contact, org } = await liveContact(row.id, tx);
    if (input.purpose !== 'confirm' && !contact.confirmedAt) denied();
    if (await tx.enterpriseRecoveryChallenge.count({ where: { contactId: row.id, createdAt: { gt: new Date(Date.now() - 3600000) } } }) >= 12) {
      throw new AppError('FORBIDDEN', 429, 'RATE_LIMITED');
    }
    const token = randomBytes(32).toString('base64url'); const expiresAt = new Date(Date.now() + 300000);
    await tx.enterpriseRecoveryChallenge.create({ data: { contactId: row.id, tokenHash: hashAssuranceReference(token),
      browserHash: hashAssuranceReference(input.browser), purpose: input.purpose, expiresAt } });
    return { ok: true, challenge: token, expires_at: expiresAt.toISOString(), organisation_name: org.name,
      purpose: input.purpose, confirmed: Boolean(contact.confirmedAt) };
  });
}

/** No account/session tokens are issued. Each verified factor authorizes exactly this stored action. */
export async function completeRecoveryChallenge(input: { challenge: string; browser?: string; code: string }) {
  const result = await getAdminPrisma().$transaction(async (tx) => {
    await lockEnterpriseOutbox(tx); await lockProductTeamPolicyShared(tx);
    const challenge = await tx.enterpriseRecoveryChallenge.findUnique({ where: { tokenHash: hashAssuranceReference(input.challenge) } });
    if (!challenge || !input.browser || challenge.browserHash !== hashAssuranceReference(input.browser)) return null;
    const attempt = await tx.enterpriseRecoveryChallenge.updateMany({ where: { id: challenge.id, consumedAt: null,
      attempts: { lt: 6 }, expiresAt: { gt: new Date() } }, data: { attempts: { increment: 1 } } });
    if (attempt.count !== 1 || !/^\d{6}$/.test(input.code)) return null;
    let source: Awaited<ReturnType<typeof liveContact>>;
    try {
      source = await liveContact(challenge.contactId, tx);
      await lockRefreshSessionUserDomain({ userId: source.contact.userId, domain: source.contact.clientDomain }, { prisma: tx });
      await lockEnterpriseScope(tx, source.contact.clientDomain, source.contact.orgId);
      source = await liveContact(challenge.contactId, tx);
      if (challenge.purpose !== 'confirm' && !source.contact.confirmedAt) return null;
      await verifyTwoFactorForLogin({ userId: source.contact.userId, code: input.code }, { prisma: tx });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) return null;
      throw error;
    }
    const { contact, policy } = source; const now = new Date();
    if (challenge.purpose === 'confirm') await tx.enterpriseRecoveryContact.update({ where: { id: contact.id },
      data: { confirmedAt: contact.confirmedAt ?? now } });
    else if (challenge.purpose === 'drill') await tx.enterpriseRecoveryContact.update({ where: { id: contact.id }, data: { lastDrillAt: now } });
    else if (challenge.purpose === 'recover') {
      const updated = await tx.orgSsoPolicy.update({ where: { clientDomain_orgId: {
        clientDomain: contact.clientDomain, orgId: contact.orgId } }, data: { enforcement: 'off', generation: { increment: 1 }, revision: { increment: 1 } } });
      const connections = await tx.orgSsoConnection.findMany({ where: { clientDomain: contact.clientDomain, orgId: contact.orgId } });
      for (const connection of connections) {
        await tx.orgSsoConnection.update({ where: { id: connection.id }, data: { status: 'suspended', scimEnabled: false,
          generation: { increment: 1 }, scimRevision: { increment: 1 } } });
        await tx.scimConnectionToken.updateMany({ where: { connectionId: connection.id, revokedAt: null }, data: { revokedAt: now } });
        await lockAndWithdrawConnectionMemberships(connection.id, tx);
      }
      await revokeEnterpriseScope({ scope: 'product_org', clientDomain: contact.clientDomain, orgId: contact.orgId, revision: updated.generation }, tx);
    } else denied();
    await tx.enterpriseRecoveryChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
    await tx.enterpriseRecoveryAction.create({ data: { contactId: contact.id, clientDomain: contact.clientDomain,
      orgId: contact.orgId, userId: contact.userId, credentialEpoch: contact.credentialEpoch,
      purpose: challenge.purpose, authenticatedAt: now, browserHash: challenge.browserHash } });
    await tx.orgAuditLog.create({ data: { orgId: contact.orgId, actorUserId: contact.userId, action: `sso.recovery_${challenge.purpose}`,
      targetType: 'organisation', targetId: contact.orgId, metadata: { recovery_revision: policy.recoveryRevision } } });
    return { ok: true, action: challenge.purpose };
  }, { timeout: 30000 });
  if (!result) denied(); return result;
}
