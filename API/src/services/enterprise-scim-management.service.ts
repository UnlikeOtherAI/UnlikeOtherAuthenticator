import type { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { managementSession, ManagementDb } from './org-sso-management.service.js';
import { issueScimToken, scimBase } from './enterprise-scim.service.js';
import { parseScimAttributes } from './enterprise-scim-protocol.service.js';
import { reconcileScimResource } from './enterprise-scim-reconciliation.service.js';
import { enterpriseRevocationReady } from './enterprise-revocation-readiness.service.js';

type Session = Awaited<ReturnType<typeof managementSession>>;
export async function ownerScimConnection(session: Session, id: string, db: ManagementDb) {
  const connection = await db.orgSsoConnection.findFirst({ where: { id, clientDomain: session.clientDomain, orgId: session.orgId } });
  const policy = await db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: { clientDomain: session.clientDomain, orgId: session.orgId } } });
  if (!connection) throw new AppError('NOT_FOUND', 404);
  if (!policy?.arrangementEnabled) throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
  return connection;
}
export async function ownerScimView(session: Session, id: string, db: ManagementDb,
  cursors: { identity_cursor?: string; resource_cursor?: string } = {}) {
  const connection = await ownerScimConnection(session, id, db);
  const [tokens, pending, identities, groups] = await Promise.all([
    db.scimConnectionToken.findMany({ where: { connectionId: id }, select: { id: true, createdAt: true, expiresAt: true, revokedAt: true },
      orderBy: { createdAt: 'desc' }, take: 10 }),
    db.scimResourceLink.findMany({ where: { connectionId: id, resourceType: 'Users', subjectBinding: null, deletedAt: null,
      ...(cursors.resource_cursor ? { id: { gt: cursors.resource_cursor } } : {}) }, orderBy: { id: 'asc' }, take: 101 }),
    db.externalIdentity.findMany({ where: { connectionId: id, status: 'ACTIVE',
      ...(cursors.identity_cursor ? { id: { gt: cursors.identity_cursor } } : {}) }, orderBy: { id: 'asc' }, take: 101,
    select: { id: true, subject: true, userId: true } }),
    db.scimResourceLink.findMany({ where: { connectionId: id, resourceType: 'Groups', deletedAt: null }, orderBy: { id: 'asc' }, take: 1000 }),
  ]);
  return { ok: true, enabled: connection.scimEnabled, revision: connection.scimRevision, base_url: scimBase(id),
    tokens: tokens.map((token) => ({ id: token.id, created_at: token.createdAt.toISOString(), expires_at: token.expiresAt.toISOString(),
      revoked_at: token.revokedAt?.toISOString() ?? null })),
    pending_resources: pending.slice(0, 100).map((row) => { const attrs = parseScimAttributes(row.attributes); return {
      id: row.id, resource_type: row.resourceType, external_id: row.externalId, user_name: attrs.userName ?? null,
      display_name: attrs.displayName ?? null, version: row.version,
    }; }),
    linked_identities: identities.slice(0, 100).map((identity) => ({ id: identity.id, subject: identity.subject, user_id: identity.userId })),
    next_resource_cursor: pending.length > 100 ? pending[99].id : null,
    next_identity_cursor: identities.length > 100 ? identities[99].id : null,
    groups: groups.map((group) => ({ id: group.id, external_id: group.externalId,
      display_name: parseScimAttributes(group.attributes).displayName ?? '', version: group.version })),
  };
}
async function requireScimProvisioningReady(clientDomain: string, db: ManagementDb): Promise<void> {
  const product = await db.enterpriseProductReadiness.findUnique({ where: { clientDomain } });
  if (product?.minimumAssuranceVersion !== 1 || !product.authorityMigrationRevision || !product.revocationConsumersRevision ||
    !await enterpriseRevocationReady(clientDomain, db)) {
    throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
  }
}
export async function setOwnerScimState(session: Session, id: string, revision: number, enabled: boolean, tx: Prisma.TransactionClient) {
  const connection = await ownerScimConnection(session, id, tx);
  if (connection.scimRevision !== revision) throw new AppError('BAD_REQUEST', 409, 'SSO_REVISION_CONFLICT');
  if (enabled) await requireScimProvisioningReady(session.clientDomain, tx);
  if (enabled && ['disabled', 'suspended'].includes(connection.status)) throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
  const row = await tx.orgSsoConnection.update({ where: { id }, data: { scimEnabled: enabled, scimRevision: { increment: 1 } } });
  if (!enabled) await tx.scimConnectionToken.updateMany({ where: { connectionId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.orgAuditLog.create({ data: { orgId: session.orgId, actorUserId: session.userId, action: 'scim.state_changed',
    targetType: 'organisation', targetId: id, metadata: { enabled, revision: row.scimRevision } } });
  return { ok: true, enabled: row.scimEnabled, revision: row.scimRevision };
}
export async function issueOwnerScimToken(session: Session, id: string, tx: Prisma.TransactionClient) {
  const connection = await ownerScimConnection(session, id, tx);
  if (!connection.scimEnabled || ['disabled', 'suspended'].includes(connection.status)) {
    throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
  }
  await requireScimProvisioningReady(session.clientDomain, tx);
  const result = await issueScimToken(id, tx);
  await tx.orgAuditLog.create({ data: { orgId: session.orgId, actorUserId: session.userId, action: 'scim.token_issued',
    targetType: 'organisation', targetId: id, metadata: { token_id: result.id, expires_at: result.expires_at } } });
  return result;
}
export async function revokeOwnerScimToken(session: Session, id: string, tokenId: string, tx: Prisma.TransactionClient) {
  await ownerScimConnection(session, id, tx);
  const token = await tx.scimConnectionToken.findFirst({ where: { id: tokenId, connectionId: id }, select: { revokedAt: true } });
  if (!token) throw new AppError('NOT_FOUND', 404);
  if (!token.revokedAt) await tx.scimConnectionToken.update({ where: { id: tokenId }, data: { revokedAt: new Date() } });
  await tx.orgAuditLog.create({ data: { orgId: session.orgId, actorUserId: session.userId, action: 'scim.token_revoked',
    targetType: 'organisation', targetId: id, metadata: { token_id: tokenId } } });
  return { ok: true };
}
export async function reconcileOwnerScimResource(session: Session, id: string,
  input: { resource_id: string; external_identity_id: string; version: number }, tx: Prisma.TransactionClient) {
  const connection = await ownerScimConnection(session, id, tx);
  if (!connection.scimEnabled) throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
  return reconcileScimResource({ connectionId: id, resourceId: input.resource_id, externalIdentityId: input.external_identity_id,
    version: input.version, actorUserId: session.userId }, tx);
}
