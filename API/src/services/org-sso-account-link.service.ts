import { getAdminPrisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { EnterpriseAuthorization } from './enterprise-authorization-context.service.js';
import { requireLiveConnection } from './org-sso-entry.service.js';
import { openEnterpriseSecret } from './enterprise-secret.service.js';
import { requireAuthenticationEvidence } from './authentication-evidence.service.js';
import { admitEnterpriseIdentity } from './org-sso-admission.service.js';
import { finalizeEnterpriseAdmission } from './org-sso-login-finalize.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { assertEnterpriseIdentityNotErased } from './enterprise-identity-status.service.js';

function denied(): never { throw new AppError('UNAUTHORIZED', 401, 'SSO_ACCOUNT_LINK_PROOF_REQUIRED'); }
const Identity = z.object({ issuer: z.string().min(1).max(2000), tenant: z.string().min(1).max(256),
  subject: z.string().min(1).max(256), email: z.string().email().max(320).optional(), emailVerified: z.boolean(),
  groups: z.array(z.string().min(1).max(256)).max(1000), authenticatedAt: z.coerce.date().nullable(),
  observedAt: z.coerce.date(), sessionExpiresAt: z.coerce.date(), amr: z.array(z.string().max(100)).max(50), acr: z.string().max(500).optional() }).strict();

export async function requireEnterpriseLink(input: { linkIntentId: string; browser?: string;
  config: ClientConfig; configUrl: string }, tx: Prisma.TransactionClient) {
  const link = await tx.orgSsoLinkIntent.findUnique({ where: { id: input.linkIntentId } });
  if (!link || !input.browser || link.browserHash !== hashAssuranceReference(input.browser) ||
    link.expiresAt <= new Date() || link.consumedAt) denied();
  const context = EnterpriseAuthorization.parse(link.context);
  if (context.config_url !== input.configUrl || context.client_domain !== input.config.domain ||
    context.config_fingerprint !== fingerprintClientConfig(input.config)) denied();
  const current = await requireLiveConnection(link.connectionId, tx);
  if (current.connection.revision !== link.revision || current.connection.generation !== link.generation ||
    current.policy.generation !== context.policy_generation || current.connection.orgId !== link.orgId) denied();
  return { link, context, ...current };
}

/** Reveal only the live destination after validating its original browser-bound intent. */
export async function enterpriseAccountLinkContext(input: Parameters<typeof requireEnterpriseLink>[0]) {
  return getAdminPrisma().$transaction(async tx => {
    const { link } = await requireEnterpriseLink(input, tx);
    const org = await tx.organisation.findUnique({ where: { id: link.orgId }, select: { id: true, name: true } });
    if (!org) denied();
    return { ok: true, org, client_domain: link.clientDomain };
  });
}

/** Called only with a fresh existing UOA credential/factor proof, never an email match. */
export async function completeEnterpriseLink(input: { linkIntentId: string; browser?: string;
  config: ClientConfig; configUrl: string; userId: string; credentialEpoch: number; authenticationEvidenceId: string; ip?: string },
tx: Prisma.TransactionClient) {
  const { link, context, connection, policy } = await requireEnterpriseLink(input, tx);
  await lockAndAssertAuthenticationEpoch({ userId: input.userId, domain: input.config.domain,
    credentialEpoch: input.credentialEpoch }, { prisma: tx });
  const proof = await requireAuthenticationEvidence({ id: input.authenticationEvidenceId, userId: input.userId,
    credentialEpoch: input.credentialEpoch, clientDomain: input.config.domain }, tx);
  const binding = hashAssuranceReference(JSON.stringify({ config: context.config_fingerprint, configUrl: context.config_url,
    redirectUrl: context.redirect_url, codeChallenge: context.code_challenge }));
  if (proof.actionBinding !== binding) denied();
  const user = await tx.user.findUnique({ where: { id: input.userId }, select: { twoFaEnabled: true } });
  const freshFactor = proof.mfaCompletedAt && proof.mfaCompletedAt.getTime() + 600000 > Date.now();
  const freshPassword = proof.method === 'email_password' && proof.authenticatedAt && proof.authenticatedAt.getTime() + 600000 > Date.now();
  if (!user || proof.provenance !== 'independent' || proof.purpose !== 'authorize' ||
    (!freshFactor && (!freshPassword || user.twoFaEnabled))) denied();
  const identity = Identity.parse(JSON.parse(await openEnterpriseSecret(
    z.object({ sealed: z.string() }).strict().parse(link.identity).sealed, `link:${link.flowId}`)));
  if (identity.sessionExpiresAt <= new Date()) denied();
  const member = await tx.orgMember.findUnique({ where: { orgId_userId: { orgId: link.orgId, userId: input.userId } } });
  if (member && member.status !== 'ACTIVE') denied();
  const claim = identity.email && identity.emailVerified ? await tx.organisationEmailDomain.findFirst({ where: {
    clientDomain: link.clientDomain, orgId: link.orgId, emailDomain: identity.email.split('@')[1].toLowerCase(),
    status: 'VERIFIED', verifiedAt: { not: null }, lastVerifiedAt: { gt: new Date(Date.now() - 86400000) },
  } }) : null;
  if (!member && (!policy.jitEnabled || !policy.defaultTeamId || !claim)) denied();
  const tuple = { connectionId: connection.id, issuer: identity.issuer, tenant: identity.tenant, subject: identity.subject };
  await assertEnterpriseIdentityNotErased(tuple, tx);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`enterprise-subject:${JSON.stringify(tuple)}`},0))`;
  const existing = await tx.externalIdentity.findUnique({ where: { connectionId_issuer_tenant_subject: tuple } });
  if (existing && (existing.userId !== input.userId || existing.status !== 'ACTIVE' || existing.identityScope !== input.config.user_scope)) denied();
  const claimed = await tx.orgSsoLinkIntent.updateMany({ where: { id: link.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() } });
  if (claimed.count !== 1) denied();
  if (!existing) await tx.externalIdentity.create({ data: { ...tuple, userId: input.userId, clientDomain: link.clientDomain,
    orgId: link.orgId, identityScope: input.config.user_scope, linkedVia: 'independent_account_proof',
    proofAuthenticationEvidenceId: proof.id, domainClaimId: member ? null : claim?.id } });
  const consumed = await tx.authenticationEvidence.updateMany({ where: { id: proof.id, consumedAt: null, revokedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) denied();
  const admitted = await admitEnterpriseIdentity({ connection, policy, identity, config: input.config, context }, tx);
  if (admitted.kind !== 'admitted' || admitted.user.id !== input.userId) denied();
  if (freshFactor) admitted.evidence = await tx.authenticationEvidence.update({ where: { id: admitted.evidence.id },
    data: { mfaCompletedAt: proof.mfaCompletedAt } });
  await tx.orgAuditLog.create({ data: { orgId: link.orgId, actorUserId: input.userId, action: 'sso.identity_linked',
    targetType: 'user', targetId: input.userId, metadata: { connection_id: connection.id, proof_id: proof.id } } });
  const result = await finalizeEnterpriseAdmission(admitted, input.config, context, tx, input.ip);
  return { ok: true, redirect_to: result.destination };
}
