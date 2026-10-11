import { createLocalJWKSet, jwtVerify } from 'jose';
import type { PrismaClient } from '@prisma/client';
import { getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { getAccessTokenPublicJwks, signKelpiePairingTicket } from './access-token.service.js';
import { verifyPublicAccountToken } from './account.service.js';
import { getOAuthClient } from './client.service.js';
import { buildMcpClientConfig } from './config.service.js';
import { authorizeKelpieAccount } from './kelpie-connect.service.js';
import { KELPIE_APP_ID, KELPIE_CONNECT_SCOPE, KELPIE_TICKET_TTL_SECONDS,
  rejectKelpieConnection } from './kelpie-connect-policy.js';

type Binding = { challenge: string; clientId: string };
const audience = (challenge: string) => `urn:unlikeotherai:kelpie:pair:${challenge}`;

export async function issueKelpiePairingTicket(params: Binding & { authorization?: string }, db: PrismaClient) {
  const account = await verifyPublicAccountToken(params.authorization, KELPIE_CONNECT_SCOPE);
  return db.$transaction(async (tx) => {
    await authorizeKelpieAccount(account, tx);
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(account.expiresAt, issuedAt + KELPIE_TICKET_TTL_SECONDS);
    if (expiresAt <= issuedAt) rejectKelpieConnection();
    const pairingTicket = await signKelpiePairingTicket({ subject: account.userId, clientId: account.clientId,
      appId: KELPIE_APP_ID, resource: audience(params.challenge), issuer: getPublicBaseUrl(),
      credentialEpoch: account.credentialEpoch, twoFaCompleted: account.twoFaCompleted, issuedAt, expiresAt,
      challenge: params.challenge, pairingClientId: params.clientId });
    return { pairing_ticket: pairingTicket, token_type: 'Bearer', expires_in: expiresAt - issuedAt };
  });
}

export async function validateKelpiePairingTicket(params: Binding & {
  authorization?: string; ticket: string;
}, db: PrismaClient) {
  // Only this receiver's invalid account may cause 401 and native sign-out.
  // A stranger's invalid proof must never erase the receiver's healthy session.
  const receiver = await verifyPublicAccountToken(params.authorization, 'profile');
  const keys = createLocalJWKSet(await getAccessTokenPublicJwks());
  let proof: { clientId: string; credentialEpoch: number; expiresAt: number; twoFaCompleted: boolean } | undefined;
  try {
    const payload = (await jwtVerify(params.ticket, keys, {
      issuer: getPublicBaseUrl(), audience: audience(params.challenge), algorithms: ['RS256'], typ: 'at+jwt',
      requiredClaims: ['sub', 'iat', 'exp', 'jti', 'client_id', 'app_id', 'tv', 'twofa', 'scope', 'token_use',
        'challenge', 'pairing_client_id'],
    })).payload;
    if (payload.aud !== audience(params.challenge) || payload.sub !== receiver.userId ||
        payload.token_use !== 'kelpie_pair' || payload.scope !== KELPIE_CONNECT_SCOPE || payload.app_id !== KELPIE_APP_ID ||
        payload.challenge !== params.challenge || payload.pairing_client_id !== params.clientId ||
        typeof payload.client_id !== 'string' || !payload.client_id || typeof payload.jti !== 'string' || !payload.jti ||
        typeof payload.tv !== 'number' || !Number.isSafeInteger(payload.tv) || payload.tv < 0 ||
        typeof payload.twofa !== 'boolean' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > Date.now() / 1000 ||
        payload.exp <= payload.iat || payload.exp - payload.iat > KELPIE_TICKET_TTL_SECONDS) throw new Error('proof');
    proof = { clientId: payload.client_id, credentialEpoch: payload.tv,
      expiresAt: payload.exp, twoFaCompleted: payload.twofa };
  } catch {
    proof = undefined;
  }
  return db.$transaction(async (tx) => {
    await authorizeKelpieAccount(receiver, tx, 'profile');
    if (!proof) return { active: false };
    try {
      const client = await getOAuthClient(proof.clientId, tx);
      if (!client) rejectKelpieConnection();
      const config = buildMcpClientConfig(client.redirectUris, client.nativeApp);
      await authorizeKelpieAccount({ userId: receiver.userId, clientId: proof.clientId,
        credentialEpoch: proof.credentialEpoch, expiresAt: proof.expiresAt, twoFaCompleted: proof.twoFaCompleted,
        domain: config.domain, config }, tx);
      return { active: true, expires_at: Math.min(proof.expiresAt, receiver.expiresAt) * 1000 };
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500) return { active: false };
      throw error;
    }
  });
}
