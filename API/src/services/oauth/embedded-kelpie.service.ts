import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { lockTokenIssuanceProductPolicy } from '../product-team-policy-lock.service.js';
import { lockAndAssertAuthenticationEpoch } from '../authentication-epoch.service.js';
import { authorizeCredentialSurface } from '../credential-route-registry.service.js';
import { validateSessionAssurance } from '../session-assurance.service.js';
import { resolveTwoFaPolicy, isTwoFaAuthenticationSufficient } from '../twofactor-policy.service.js';
import { assertNotBannedAtLogin } from '../ban-policy.service.js';
import { assertEmailDomainAllowedForLogin } from '../login-domain-policy.service.js';
import { lockSignaturePolicyForDecision } from '../signature-policy-lock.service.js';
import { evaluateSignaturePolicy } from '../signature-policy.service.js';
import { getAccessTokenPublicJwks, signEmbeddedKelpieToken } from './access-token.service.js';
import { kelpieConnectResource, KELPIE_TICKET_TTL_SECONDS } from './kelpie-connect-policy.js';

const SCOPES = 'profile email settings.read settings.write kelpie.connect';
const Claims = z.object({
  sub: z.string().min(1).max(256), domain: z.string().min(1).max(253),
  client_domain_id: z.string().min(1).max(256), assurance_id: z.string().min(1).max(256),
  org_id: z.string().min(1).max(256).nullable(), team_id: z.string().min(1).max(256).nullable(),
  tv: z.number().int().nonnegative(), iat: z.number().int().positive(), exp: z.number().int().positive(),
  jti: z.string().min(1).max(256), scope: z.literal(SCOPES),
});
export type EmbeddedKelpieAccount = z.infer<typeof Claims>;
function reject(): never { throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED'); }
const audience = () => `${getPublicBaseUrl()}/embedded/kelpie`;

/** This grant is the gateway product's existing person session, never a public native registration. */
export async function authorizeEmbeddedKelpieAccount(account: EmbeddedKelpieAccount, tx: Prisma.TransactionClient) {
  const resource = kelpieConnectResource();
  if (account.domain !== new URL(resource).host || account.exp <= Date.now() / 1000) reject();
  await lockTokenIssuanceProductPolicy({ clientDomainId: account.client_domain_id, domain: account.domain }, { prisma: tx });
  await lockAndAssertAuthenticationEpoch({ userId: account.sub, domain: account.domain, credentialEpoch: account.tv }, { prisma: tx });
  const binding = { userId: account.sub, clientDomain: account.domain, credentialEpoch: account.tv,
    orgId: account.org_id, teamId: account.team_id, assuranceId: account.assurance_id };
  // Global profile/settings require independent original proof, including its live family and ancestors.
  await authorizeCredentialSurface('configured_access', binding, tx);
  const proof = await validateSessionAssurance({ ...binding, id: account.assurance_id, requirement: 'global_account_control' }, tx);
  if (account.exp > Math.floor(proof.expiresAt.getTime() / 1000)) reject();
  const [user, role, policy] = await Promise.all([
    tx.user.findUnique({ where: { id: account.sub, lifecycleStatus: 'ACTIVE' }, select: { twoFaEnabled: true } }),
    tx.domainRole.findUnique({ where: { domain_userId: { domain: account.domain, userId: account.sub } }, select: { role: true } }),
    resolveTwoFaPolicy({ config: { domain: account.domain, '2fa_enabled': true }, userId: account.sub, orgId: account.org_id }, { prisma: tx }),
  ]);
  if (!user || !role || !isTwoFaAuthenticationSufficient({ policy, twoFaEnabled: user.twoFaEnabled,
    twoFaCompleted: proof.mfaSource === 'uoa_totp' })) reject();
  const login = { userId: account.sub, domain: account.domain };
  await assertNotBannedAtLogin(login, { prisma: tx });
  await assertEmailDomainAllowedForLogin(login, { prisma: tx });
  await lockSignaturePolicyForDecision(tx, account.domain);
  if (!(await evaluateSignaturePolicy(login, { prisma: tx })).complete) reject();
  return proof;
}

/** Only called after domain/config authentication and verification of the host's subject assertion. */
export async function issueEmbeddedKelpieSession(params: {
  userId: string; domain: string; clientDomainId: string; credentialEpoch: number; assuranceId: string;
  orgId: string | null; teamId: string | null;
}, db: PrismaClient) {
  return db.$transaction(async tx => {
    const now = Math.floor(Date.now() / 1000);
    const proof = await validateSessionAssurance({ id: params.assuranceId, userId: params.userId,
      clientDomain: params.domain, credentialEpoch: params.credentialEpoch, orgId: params.orgId, teamId: params.teamId,
      requirement: 'global_account_control' }, tx);
    const account: EmbeddedKelpieAccount = { sub: params.userId, domain: params.domain, client_domain_id: params.clientDomainId,
      assurance_id: proof.id, org_id: params.orgId, team_id: params.teamId, tv: params.credentialEpoch,
      iat: now, exp: Math.min(now + KELPIE_TICKET_TTL_SECONDS, Math.floor(proof.expiresAt.getTime() / 1000)),
      jti: randomUUID(), scope: SCOPES };
    await authorizeEmbeddedKelpieAccount(account, tx);
    const accessToken = await signEmbeddedKelpieToken(account, audience(), 'embedded_kelpie_account');
    return { access_token: accessToken, token_type: 'Bearer', expires_in: account.exp - now,
      sub: account.sub, issuer: getPublicBaseUrl() };
  });
}

export async function verifyEmbeddedKelpieToken(authorization: string | undefined, scope: string) {
  try {
    if (!authorization?.startsWith('Bearer ')) reject();
    const { payload } = await jwtVerify(authorization.slice(7), createLocalJWKSet(await getAccessTokenPublicJwks()), {
      algorithms: ['RS256'], typ: 'at+jwt', issuer: getPublicBaseUrl(), audience: audience(),
    });
    if (payload.token_use !== 'embedded_kelpie_account' || payload.aud !== audience()) reject();
    const account = Claims.parse(payload);
    if (account.exp <= account.iat || account.exp - account.iat > KELPIE_TICKET_TTL_SECONDS ||
      account.iat > Date.now() / 1000 || !SCOPES.split(' ').includes(scope)) reject();
    return { ...account, userId: account.sub };
  } catch (error) {
    if (error instanceof AppError && error.statusCode >= 500) throw error;
    reject();
  }
}

export async function issueEmbeddedKelpieConnection(authorization: string | undefined, resource: string, db: PrismaClient) {
  if (resource !== kelpieConnectResource()) throw new AppError('BAD_REQUEST', 400, 'INVALID_TARGET');
  const account = await verifyEmbeddedKelpieToken(authorization, 'kelpie.connect');
  return db.$transaction(async tx => {
    await authorizeEmbeddedKelpieAccount(account, tx);
    const now = Math.floor(Date.now() / 1000);
    const ticket = await signEmbeddedKelpieToken({ ...account, jti: randomUUID(), iat: now }, resource, 'embedded_kelpie_connect');
    const gateway = new URL(resource); gateway.protocol = 'wss:';
    return { connection_ticket: ticket, token_type: 'Bearer', expires_in: account.exp - now, gateway_url: gateway.toString() };
  });
}

export async function validateEmbeddedKelpieConnection(ticket: string, db: PrismaClient, authorizeGateway: (tx: Prisma.TransactionClient) => Promise<void>) {
  const resource = kelpieConnectResource();
  let account: EmbeddedKelpieAccount;
  try {
    const { payload } = await jwtVerify(ticket, createLocalJWKSet(await getAccessTokenPublicJwks()), {
      algorithms: ['RS256'], typ: 'at+jwt', issuer: getPublicBaseUrl(), audience: resource,
    });
    if (payload.token_use !== 'embedded_kelpie_connect' || payload.aud !== resource) reject();
    account = Claims.parse(payload);
    if (account.exp <= account.iat || account.exp - account.iat > KELPIE_TICKET_TTL_SECONDS || account.iat > Date.now() / 1000) reject();
  } catch { return reject(); }
  return db.$transaction(async tx => {
    await authorizeEmbeddedKelpieAccount(account, tx);
    await authorizeGateway(tx);
    return { active: true, source: 'embedded', iss: getPublicBaseUrl(), sub: account.sub, aud: resource,
      client_id: `embedded:${account.client_domain_id}`, app_id: `embedded:${account.domain}`, exp: account.exp, jti: account.jti };
  });
}
