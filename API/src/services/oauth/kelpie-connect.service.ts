import { createLocalJWKSet, jwtVerify } from 'jose';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { verifyDomainAuthToken } from '../domain-secret.service.js';
import { assertNotBannedAtLogin } from '../ban-policy.service.js';
import { assertEmailDomainAllowedForLogin } from '../login-domain-policy.service.js';
import { lockSignaturePolicyForDecision } from '../signature-policy-lock.service.js';
import { evaluateSignaturePolicy } from '../signature-policy.service.js';
import { getAccessTokenPublicJwks, signKelpieConnectionTicket } from './access-token.service.js';
import { authorizePublicAccount, verifyPublicAccountToken } from './account.service.js';
import { getOAuthClient } from './client.service.js';
import { buildMcpClientConfig } from './config.service.js';
import { validatePublicScopes } from './scopes.service.js';
import { KELPIE_APP_ID, KELPIE_CONNECT_SCOPE, KELPIE_TICKET_TTL_SECONDS,
  kelpieConnectResource, rejectKelpieConnection } from './kelpie-connect-policy.js';

type Account = Awaited<ReturnType<typeof verifyPublicAccountToken>>;

async function authorizeKelpieAccount(account: Account, tx: Prisma.TransactionClient): Promise<void> {
  try {
    // Pins app revision and credential epoch against every security-policy writer.
    await authorizePublicAccount(account, tx);
    const client = await getOAuthClient(account.clientId, tx);
    if (client?.nativeApp?.identifier !== KELPIE_APP_ID ||
        !client.scopes.includes(KELPIE_CONNECT_SCOPE) ||
        !client.nativeApp.scopes.includes(KELPIE_CONNECT_SCOPE)) rejectKelpieConnection();
    validatePublicScopes(KELPIE_CONNECT_SCOPE, client.scopes);
    const domain = await tx.clientDomain.findUnique({ where: { domain: account.domain }, select: { status: true } });
    if (domain?.status === 'disabled') rejectKelpieConnection();
    await assertNotBannedAtLogin(account, { prisma: tx });
    await assertEmailDomainAllowedForLogin(account, { prisma: tx });
    await lockSignaturePolicyForDecision(tx, account.domain);
    if (!(await evaluateSignaturePolicy(account, { prisma: tx })).complete) rejectKelpieConnection();
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500) rejectKelpieConnection();
    throw error;
  }
}

export async function issueKelpieConnectionTicket(params: {
  authorization?: string; resource: string;
}, db: PrismaClient) {
  const resource = kelpieConnectResource();
  if (params.resource !== resource) throw new AppError('BAD_REQUEST', 400, 'INVALID_TARGET');
  const account = await verifyPublicAccountToken(params.authorization, KELPIE_CONNECT_SCOPE);
  return db.$transaction(async (tx) => {
    await authorizeKelpieAccount(account, tx);
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(account.expiresAt, issuedAt + KELPIE_TICKET_TTL_SECONDS);
    if (expiresAt <= issuedAt) rejectKelpieConnection();
    const ticket = await signKelpieConnectionTicket({ subject: account.userId, clientId: account.clientId,
      appId: KELPIE_APP_ID, resource, issuer: getPublicBaseUrl(), credentialEpoch: account.credentialEpoch,
      twoFaCompleted: account.twoFaCompleted, issuedAt, expiresAt });
    const gateway = new URL(resource); gateway.protocol = 'wss:';
    return { connection_ticket: ticket, token_type: 'Bearer', expires_in: expiresAt - issuedAt, gateway_url: gateway.toString() };
  });
}

export async function validateKelpieConnectionTicket(params: {
  ticket: string; domain: string; domainCredential: string;
}, db: PrismaClient) {
  const resource = kelpieConnectResource();
  const issuer = getPublicBaseUrl();
  // Domain input is already authenticated by the route; exact resource host is the only caller.
  if (params.domain !== new URL(resource).host) rejectKelpieConnection();
  let payload;
  try {
    payload = (await jwtVerify(params.ticket, createLocalJWKSet(await getAccessTokenPublicJwks()), {
      algorithms: ['RS256'], typ: 'at+jwt', issuer, audience: resource,
      requiredClaims: ['sub', 'iat', 'exp', 'jti', 'client_id', 'app_id', 'tv', 'twofa', 'scope', 'token_use'],
    })).payload;
    if (payload.aud !== resource || payload.token_use !== 'kelpie_connect' || payload.scope !== KELPIE_CONNECT_SCOPE ||
        payload.app_id !== KELPIE_APP_ID || typeof payload.sub !== 'string' || !payload.sub ||
        typeof payload.client_id !== 'string' || !payload.client_id || typeof payload.jti !== 'string' || !payload.jti ||
        typeof payload.tv !== 'number' || !Number.isSafeInteger(payload.tv) || payload.tv < 0 ||
        typeof payload.twofa !== 'boolean' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > Date.now() / 1000 ||
        payload.exp <= payload.iat || payload.exp - payload.iat > KELPIE_TICKET_TTL_SECONDS) rejectKelpieConnection();
  } catch {
    rejectKelpieConnection();
  }
  const { sub, client_id: clientId, tv: credentialEpoch, exp: expiresAt, twofa } = payload;
  return db.$transaction(async (tx) => {
    const client = await getOAuthClient(clientId, tx);
    if (!client) rejectKelpieConnection();
    const config = buildMcpClientConfig(client.redirectUris, client.nativeApp);
    await authorizeKelpieAccount({ userId: sub, clientId, credentialEpoch, expiresAt,
      twoFaCompleted: twofa, domain: config.domain, config }, tx);
    // Re-resolve the backend under the same policy lock; rotation/disable cannot race validation.
    await verifyDomainAuthToken({ domain: params.domain, token: params.domainCredential }, { prisma: tx as unknown as PrismaClient });
    return { active: true, iss: issuer, sub, aud: resource, client_id: clientId,
      app_id: KELPIE_APP_ID, exp: expiresAt, jti: payload.jti };
  });
}
