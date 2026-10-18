import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, OrgSsoConnection, OrgSsoPolicy } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import type { VerifiedEnterpriseIdentity } from './org-sso-oidc.service.js';
import { buildUserIdentity } from './user-scope.service.js';
import { connectionGroupMappings } from './enterprise-group-mapping.service.js';
import { replaceManagedMemberships, type ManagedMembershipGrant } from './membership-provenance.service.js';
import type { EnterpriseAuthorizationContext } from './enterprise-authorization-context.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { lockTeamMembershipRows } from './team-scope.service.js';
import { assertEnterpriseIdentityNotErased, assertEnterpriseProvisioningActive } from './enterprise-identity-status.service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function denied(code: string): never { throw new AppError('FORBIDDEN', 403, code); }

/** Stable external tuples alone identify linked users; email is never an account-link proof. */
export async function admitEnterpriseIdentity(input: { connection: OrgSsoConnection; policy: OrgSsoPolicy;
  identity: VerifiedEnterpriseIdentity; config: ClientConfig; context: EnterpriseAuthorizationContext;
}, tx: Prisma.TransactionClient) {
  const { connection, identity, policy } = input;
  const tuple = { connectionId: connection.id, issuer: identity.issuer, tenant: identity.tenant, subject: identity.subject };
  await assertEnterpriseIdentityNotErased(tuple, tx);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`enterprise-subject:${JSON.stringify(tuple)}`},0))`;
  let external = await tx.externalIdentity.findUnique({ where: { connectionId_issuer_tenant_subject: tuple } });
  if (external && (external.status !== 'ACTIVE' || external.orgId !== connection.orgId ||
    external.clientDomain !== connection.clientDomain || external.identityScope !== input.config.user_scope)) denied('SSO_IDENTITY_UNAVAILABLE');
  let user = external ? await tx.user.findUnique({ where: { id: external.userId } }) : null;
  if (external && (!user || user.lifecycleStatus !== 'ACTIVE')) denied('SSO_IDENTITY_UNAVAILABLE');
  if (!external) {
    if (!identity.email || !identity.emailVerified) denied('SSO_VERIFIED_EMAIL_REQUIRED');
    // An email match only asks the person to prove their existing account. It
    // never chooses that account, transfers membership, or mutates its profile.
    const existing = await tx.user.findMany({ where: { email: identity.email }, select: { id: true }, take: 100 });
    if (existing.length) return { kind: 'link_required' as const, candidateUserIds: existing.map((row) => row.id) };
    const domain = identity.email.split('@')[1]?.toLowerCase();
    const claim = domain ? await tx.organisationEmailDomain.findFirst({ where: {
      clientDomain: connection.clientDomain, orgId: connection.orgId, emailDomain: domain,
      status: 'VERIFIED', verifiedAt: { not: null }, lastVerifiedAt: { gt: new Date(Date.now() - 86400000) },
    } }) : null;
    // Contractor exceptions never permit a domain-less automatic account creation.
    if (!claim || !policy.jitEnabled || !policy.defaultTeamId) denied('SSO_JIT_NOT_ALLOWED');
    const canonical = buildUserIdentity({ userScope: input.config.user_scope, email: identity.email, domain: connection.clientDomain });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`enterprise-user-key:${canonical.userKey}`},0))`;
    const raced = await tx.user.findUnique({ where: { userKey: canonical.userKey }, select: { id: true } });
    if (raced) return { kind: 'link_required' as const, candidateUserIds: [raced.id] };
    user = await tx.user.create({ data: canonical });
    external = await tx.externalIdentity.create({ data: { ...tuple, userId: user.id, clientDomain: connection.clientDomain,
      orgId: connection.orgId, identityScope: input.config.user_scope, linkedVia: 'verified_domain_jit', domainClaimId: claim.id } });
  }
  if (!external || !user) denied('SSO_IDENTITY_UNAVAILABLE');
  await assertEnterpriseProvisioningActive(connection.id, external.id, user.id, tx);
  await lockAndAssertAuthenticationEpoch({ userId: user.id, domain: connection.clientDomain,
    credentialEpoch: user.tokenVersion }, { prisma: tx });
  await lockTeamMembershipRows({ userId: user.id, orgId: connection.orgId }, { prisma: tx });
  const priorMembership = await tx.orgMember.findUnique({ where: { orgId_userId: { orgId: connection.orgId, userId: user.id } } });
  if (priorMembership && priorMembership.status !== 'ACTIVE') denied('SSO_MEMBERSHIP_SUPPRESSED');
  if (!priorMembership && !policy.jitEnabled) denied('SSO_JIT_NOT_ALLOWED');
  const grants: ManagedMembershipGrant[] = [{ teamId: null, role: 'member', resourceId: 'identity' }];
  if (policy.jitEnabled && policy.defaultTeamId) grants.push({ teamId: policy.defaultTeamId, role: 'member', resourceId: 'default' });
  const mappings = connectionGroupMappings(policy.groupMappings, connection.id);
  const groups = new Set(identity.groups);
  for (const mapping of mappings) if (groups.has(mapping.external_group_id)) grants.push({
    teamId: mapping.team_id, role: mapping.team_role, resourceId: mapping.external_group_id,
  });
  await replaceManagedMemberships({ userId: user.id, orgId: connection.orgId, clientDomain: connection.clientDomain,
    connectionId: connection.id, sourceKind: 'sso', sourceId: external.id, grants }, tx);
  await tx.externalIdentity.update({ where: { id: external.id }, data: { lastAuthenticatedAt: identity.authenticatedAt } });
  const deadline = new Date(Math.min(identity.sessionExpiresAt.getTime(),
    identity.observedAt.getTime() + policy.sessionMaxAgeSeconds * 1000,
    identity.authenticatedAt ? identity.authenticatedAt.getTime() + policy.sessionMaxAgeSeconds * 1000 : Infinity));
  if (deadline <= new Date() || (policy.reauthMode === 'force' && !identity.authenticatedAt)) denied('SSO_UPSTREAM_REAUTH_REQUIRED');
  const evidence = await tx.authenticationEvidence.create({ data: {
    referenceHash: hash(randomBytes(32).toString('base64url')), userId: user.id, credentialEpoch: user.tokenVersion,
    clientDomain: connection.clientDomain, method: 'sso', provenance: 'sso', authenticatedAt: identity.authenticatedAt,
    observedAt: identity.observedAt, connectionId: connection.id, externalIdentityId: external.id,
    connectionRevision: connection.revision, connectionGeneration: connection.generation, policyGeneration: policy.generation,
    sessionDeadline: deadline, orgId: connection.orgId, purpose: 'authorize', amr: identity.amr, acr: identity.acr,
    actionBinding: hash(JSON.stringify({ config: input.context.config_fingerprint, configUrl: input.context.config_url,
      redirectUrl: input.context.redirect_url, codeChallenge: input.context.code_challenge })),
    expiresAt: new Date(Math.min(Date.now() + 900000, deadline.getTime())),
  } });
  return { kind: 'admitted' as const, user, evidence };
}
