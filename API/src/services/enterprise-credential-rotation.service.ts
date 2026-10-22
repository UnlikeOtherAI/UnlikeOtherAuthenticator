import type { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { managementSession } from './org-sso-management.service.js';
import { publicConnection } from './org-sso-management.service.js';
import { sealEnterpriseSecret } from './enterprise-secret.service.js';
import { createEnterpriseSpKey } from './org-sso-sp-key.service.js';
import { revokeEnterpriseScope } from './org-sso-revocation.service.js';
import { SamlEnterpriseConfiguration } from './org-sso-configuration.service.js';
import { validateEnterpriseSigningCertificate } from './enterprise-signing-certificate.service.js';

type Session = Awaited<ReturnType<typeof managementSession>>;
async function connectionFor(session: Session, id: string, revision: number, tx: Prisma.TransactionClient) {
  const row = await tx.orgSsoConnection.findFirst({ where: { id, clientDomain: session.clientDomain, orgId: session.orgId } });
  if (!row || row.revision !== revision) throw new AppError('BAD_REQUEST', 409, 'SSO_REVISION_CONFLICT');
  return row;
}
async function finish(session: Session, id: string, data: Prisma.OrgSsoConnectionUpdateInput, action: string, tx: Prisma.TransactionClient) {
  const row = await tx.orgSsoConnection.update({ where: { id }, data: { ...data, revision: { increment: 1 },
    generation: { increment: 1 }, testedRevision: null, lastTestAt: null, lastTestCode: null } });
  await revokeEnterpriseScope({ scope: 'connection', clientDomain: row.clientDomain, orgId: row.orgId,
    connectionId: row.id, revision: row.generation }, tx);
  await tx.orgAuditLog.create({ data: { orgId: row.orgId, actorUserId: session.userId, action,
    targetType: 'organisation', targetId: id, metadata: { revision: row.revision, generation: row.generation } } });
  return { ok: true, connection: publicConnection(row) };
}

/** Only credentials change. Issuer, tenant, client ID, stable subject and account links remain locked. */
export async function rotateEnterpriseCredential(session: Session, id: string,
  input: { revision: number; secret?: string; certificates?: string[] }, tx: Prisma.TransactionClient) {
  const row = await connectionFor(session, id, input.revision, tx);
  if (row.protocol === 'oidc') {
    if (!input.secret || input.certificates) throw new AppError('BAD_REQUEST', 400, 'SSO_ROTATION_INVALID');
    return finish(session, id, { encryptedSecret: await sealEnterpriseSecret(input.secret, `connection:${id}`) }, 'sso.credential_rotated', tx);
  }
  if (input.secret || !input.certificates?.length) throw new AppError('BAD_REQUEST', 400, 'SSO_ROTATION_INVALID');
  input.certificates.forEach(validateEnterpriseSigningCertificate);
  const configuration = SamlEnterpriseConfiguration.parse({ ...SamlEnterpriseConfiguration.parse(row.configuration), certificates: input.certificates });
  return finish(session, id, { configuration }, 'sso.idp_certificates_rotated', tx);
}

/** Prepare publishes both keys before activation; decryption accepts either through a bounded overlap. */
export async function rotateEnterpriseSpKey(session: Session, id: string, revision: number,
  action: 'prepare' | 'activate' | 'retire', tx: Prisma.TransactionClient) {
  const row = await connectionFor(session, id, revision, tx);
  if (row.protocol !== 'saml') throw new AppError('BAD_REQUEST', 400, 'SSO_ROTATION_INVALID');
  if (action === 'prepare') {
    if (row.encryptedNextSecret || row.encryptedPreviousSecret) throw new AppError('BAD_REQUEST', 409, 'SSO_ROTATION_RETIRE_REQUIRED');
    const next = await createEnterpriseSpKey(id);
    return finish(session, id, { encryptedNextSecret: next.encryptedSecret,
      publicSigningCertificates: [...row.publicSigningCertificates.slice(0, 1), next.publicCertificate],
      keyOverlapExpiresAt: new Date(Date.now() + 14 * 86400000) }, 'sso.sp_key_prepared', tx);
  }
  if (action === 'activate') {
    if (!row.encryptedNextSecret || !row.keyOverlapExpiresAt || row.keyOverlapExpiresAt <= new Date() || row.testedRevision !== row.revision) {
      throw new AppError('BAD_REQUEST', 409, 'SSO_ROTATION_TEST_REQUIRED');
    }
    return finish(session, id, { encryptedSecret: row.encryptedNextSecret, encryptedPreviousSecret: row.encryptedSecret,
      encryptedNextSecret: null, publicSigningCertificates: [...row.publicSigningCertificates].reverse(),
      keyOverlapExpiresAt: new Date(Date.now() + 14 * 86400000) }, 'sso.sp_key_activated', tx);
  }
  if (!row.encryptedNextSecret && !row.encryptedPreviousSecret) throw new AppError('BAD_REQUEST', 409, 'SSO_ROTATION_INVALID');
  if (row.encryptedPreviousSecret && row.testedRevision !== row.revision) throw new AppError('BAD_REQUEST', 409, 'SSO_ROTATION_TEST_REQUIRED');
  return finish(session, id, { encryptedNextSecret: null, encryptedPreviousSecret: null,
    publicSigningCertificates: row.publicSigningCertificates.slice(0, 1), keyOverlapExpiresAt: null }, 'sso.sp_key_retired', tx);
}
