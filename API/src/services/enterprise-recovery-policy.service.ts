import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { ManagementDb, managementSession } from './org-sso-management.service.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';

type Session = Awaited<ReturnType<typeof managementSession>>;
export async function ownerRecoveryView(session: Session, db: ManagementDb, cursor?: string) {
  const members = await db.orgMember.findMany({ where: { orgId: session.orgId, status: 'ACTIVE',
    user: { lifecycleStatus: 'ACTIVE' }, ...(cursor ? { userId: { gt: cursor } } : {}) }, orderBy: { userId: 'asc' }, take: 101,
  select: { user: { select: { id: true, name: true, email: true, twoFaEnabled: true, twoFaSecret: true } } } });
  return { ...await recoveryReadiness(session.clientDomain, session.orgId, db), candidates: members.slice(0, 100).map(({ user }) => ({
    user_id: user.id, display_name: user.name, email: user.email, eligible: Boolean(user.twoFaEnabled && user.twoFaSecret),
  })), next_cursor: members.length > 100 ? members[99].user.id : null };
}
export async function recoveryReadiness(clientDomain: string, orgId: string, db: ManagementDb) {
  const policy = await db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: { clientDomain, orgId } } });
  const contacts = await db.enterpriseRecoveryContact.findMany({ where: { clientDomain, orgId, revokedAt: null,
    policyRevision: policy?.recoveryRevision ?? 0 }, orderBy: { id: 'asc' } });
  const people = await db.user.findMany({ where: { id: { in: contacts.map((contact) => contact.userId) }, lifecycleStatus: 'ACTIVE' },
    select: { id: true, tokenVersion: true, twoFaEnabled: true, twoFaSecret: true } });
  const members = await db.orgMember.findMany({ where: { orgId, userId: { in: contacts.map((contact) => contact.userId) }, status: 'ACTIVE' }, select: { userId: true } });
  const suitable = contacts.filter((contact) => people.some((person) => person.id === contact.userId && person.twoFaEnabled && person.twoFaSecret &&
    person.tokenVersion === contact.credentialEpoch && hashAssuranceReference(person.twoFaSecret) === contact.factorHash) &&
    members.some((member) => member.userId === contact.userId));
  const setup = contacts.length === 2 && suitable.length === 2 && suitable.every((contact) => contact.confirmedAt);
  const drill = setup && suitable.every((contact) => contact.lastDrillAt && contact.lastDrillAt.getTime() + 30 * 86400000 > Date.now());
  return { revision: policy?.recoveryRevision ?? 1, setup_complete: setup, drill_complete: drill,
    contacts: contacts.map((contact) => ({ user_id: contact.userId, status: suitable.includes(contact) ?
      contact.confirmedAt ? 'confirmed' : 'pending' : 'unavailable', confirmed_at: contact.confirmedAt?.toISOString() ?? null,
    last_drill_at: contact.lastDrillAt?.toISOString() ?? null })) };
}

/** Existing personal factors are pinned before any recovery invitation is issued. */
export async function setRecoveryContacts(session: Session, revision: number, ids: string[], tx: Prisma.TransactionClient) {
  if (ids.length !== 2 || new Set(ids).size !== 2) throw new AppError('BAD_REQUEST', 400, 'RECOVERY_TWO_CONTACTS_REQUIRED');
  const scope = { clientDomain: session.clientDomain, orgId: session.orgId };
  const policy = await tx.orgSsoPolicy.findUniqueOrThrow({ where: { clientDomain_orgId: scope } });
  if (revision !== policy.recoveryRevision) throw new AppError('BAD_REQUEST', 409, 'SSO_REVISION_CONFLICT');
  if (policy.enforcement !== 'off') throw new AppError('FORBIDDEN', 403, 'RECOVERY_DISABLE_ENFORCEMENT_FIRST');
  for (const userId of [...ids].sort()) await lockRefreshSessionUserDomain({ userId, domain: session.clientDomain }, { prisma: tx });
  const people = await tx.user.findMany({ where: { id: { in: ids }, lifecycleStatus: 'ACTIVE', twoFaEnabled: true },
    select: { id: true, tokenVersion: true, twoFaSecret: true } });
  const members = await tx.orgMember.findMany({ where: { orgId: session.orgId, userId: { in: ids }, status: 'ACTIVE' } });
  if (people.length !== 2 || people.some((person) => !person.twoFaSecret) || members.length !== 2) {
    throw new AppError('BAD_REQUEST', 400, 'RECOVERY_EXISTING_FACTOR_REQUIRED');
  }
  await tx.enterpriseRecoveryContact.updateMany({ where: { ...scope, revokedAt: null }, data: { revokedAt: new Date() } });
  const updated = await tx.orgSsoPolicy.update({ where: { clientDomain_orgId: scope }, data: { recoveryRevision: { increment: 1 } } });
  const invitations: Array<{ user_id: string; recovery_url: string }> = [];
  for (const person of people) {
    if (!person.twoFaSecret) throw new AppError('INTERNAL', 500, 'RECOVERY_EXISTING_FACTOR_REQUIRED');
    const handle = randomBytes(32).toString('base64url');
    await tx.enterpriseRecoveryContact.create({ data: { ...scope, userId: person.id, policyRevision: updated.recoveryRevision,
      credentialEpoch: person.tokenVersion, factorHash: hashAssuranceReference(person.twoFaSecret), handleHash: hashAssuranceReference(handle) } });
    const url = new URL('/auth/organisation-recovery', getPublicBaseUrl()); url.hash = `contact=${handle}`;
    invitations.push({ user_id: person.id, recovery_url: url.toString() });
  }
  await tx.orgAuditLog.create({ data: { orgId: session.orgId, actorUserId: session.userId, action: 'sso.recovery_contacts_changed',
    targetType: 'organisation', targetId: session.orgId, metadata: { recovery_revision: updated.recoveryRevision } } });
  return { ok: true, revision: updated.recoveryRevision, invitations };
}
