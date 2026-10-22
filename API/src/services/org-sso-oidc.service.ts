import { createHash, randomBytes, createPublicKey } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';
import { z } from 'zod';
import type { OrgSsoConnection, OrgSsoFlow } from '@prisma/client';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { OidcEnterpriseConfiguration } from './org-sso-configuration.service.js';
import { enterpriseFetch } from './enterprise-http.service.js';
import { openEnterpriseSecret } from './enterprise-secret.service.js';

const MAX_AUTH_AGE_SKEW = 120;
export type VerifiedEnterpriseIdentity = {
  groups: string[]; issuer: string; tenant: string; subject: string; email?: string; emailVerified: boolean;
  authenticatedAt: Date | null; observedAt: Date; sessionExpiresAt: Date; amr: string[]; acr?: string;
};
export const randomEnterpriseValue = (): string => randomBytes(32).toString('base64url');

export function enterpriseOidcAuthorize(connection: OrgSsoConnection, flow: OrgSsoFlow, verifier: string): string {
  const config = OidcEnterpriseConfiguration.parse(connection.configuration);
  const target = new URL(config.authorization_endpoint);
  target.search = new URLSearchParams({ response_type: 'code', client_id: config.client_id,
    redirect_uri: `${getPublicBaseUrl()}/sso/oidc/${connection.id}/callback`, scope: 'openid email profile',
    state: flow.id, nonce: flow.nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...(config.max_age === undefined ? {} : { max_age: String(config.max_age) }),
  }).toString();
  return target.toString();
}

export function validateEnterpriseOidcClaims(connection: OrgSsoConnection, payload: JWTPayload,
  nonce: string, accessToken: string | undefined, now = new Date()): VerifiedEnterpriseIdentity {
  const config = OidcEnterpriseConfiguration.parse(connection.configuration);
  const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
  if (payload.iss !== config.issuer || !audiences?.length ||
    !audiences.includes(config.client_id) ||
    (payload.azp !== undefined && payload.azp !== config.client_id) ||
    (audiences.length > 1 && payload.azp !== config.client_id) || payload.nonce !== nonce ||
    payload[config.tenant.claim] !== config.tenant.value ||
    typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 ||
    typeof payload.exp !== 'number' || payload.exp * 1000 <= now.getTime()) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_ASSERTION_INVALID');
  }
  if (connection.preset === 'google_workspace' && (!config.hosted_domains?.includes(String(payload.hd)))) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_TENANT_INVALID');
  }
  const subject = config.subject_claim === 'oid' ? payload.oid : payload.sub;
  if (typeof subject !== 'string' || !subject || subject.length > 256) throw new AppError('UNAUTHORIZED', 401, 'SSO_SUBJECT_INVALID');
  const authTime = typeof payload.auth_time === 'number' && Number.isSafeInteger(payload.auth_time)
    ? payload.auth_time : null;
  const nowSeconds = now.getTime() / 1000;
  if (authTime !== null && (authTime <= 0 || authTime > nowSeconds + MAX_AUTH_AGE_SKEW)) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_AUTH_TIME_INVALID');
  }
  if (config.max_age !== undefined && (authTime === null || nowSeconds - authTime > config.max_age + MAX_AUTH_AGE_SKEW)) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_AUTH_TIME_REQUIRED');
  }
  if (payload.at_hash !== undefined) {
    if (!accessToken || typeof payload.at_hash !== 'string') throw new AppError('UNAUTHORIZED', 401, 'SSO_ACCESS_HASH_INVALID');
    // Launch engine pins RS256; the hash is the left half of SHA-256 (OIDC Core 3.1.3.8).
    const expected = createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url');
    if (payload.at_hash !== expected) throw new AppError('UNAUTHORIZED', 401, 'SSO_ACCESS_HASH_INVALID');
  }
  const groups = config.groups_claim ? z.array(z.string().min(1).max(256)).max(1000)
    .parse(payload[config.groups_claim] ?? []) : [];
  return { groups: [...new Set(groups)], issuer: config.issuer, tenant: config.tenant.value, subject,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    emailVerified: payload.email_verified === true, authenticatedAt: authTime === null ? null : new Date(authTime * 1000),
    observedAt: now, sessionExpiresAt: new Date(payload.exp * 1000),
    amr: Array.isArray(payload.amr) && payload.amr.every((a) => typeof a === 'string') ? payload.amr as string[] : [],
    ...(typeof payload.acr === 'string' ? { acr: payload.acr } : {}) };
}

export async function validateEnterpriseOidcCallback(connection: OrgSsoConnection, flow: OrgSsoFlow,
  input: { code: string; iss?: string }): Promise<VerifiedEnterpriseIdentity> {
  const config = OidcEnterpriseConfiguration.parse(connection.configuration);
  if ((input.iss !== undefined && input.iss !== config.issuer) ||
    (config.authorization_response_iss_required && input.iss !== config.issuer)) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_RESPONSE_ISSUER_INVALID');
  }
  const secret = connection.encryptedSecret ? await openEnterpriseSecret(connection.encryptedSecret, `connection:${connection.id}`) : '';
  if (!secret) throw new AppError('BAD_REQUEST', 400, 'SSO_CLIENT_SECRET_REQUIRED');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code,
    redirect_uri: `${getPublicBaseUrl()}/sso/oidc/${connection.id}/callback`,
    code_verifier: await openEnterpriseSecret(flow.encryptedVerifier, `flow:${flow.id}`) });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (config.client_auth_method === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
  } else { body.set('client_id', config.client_id); body.set('client_secret', secret); }
  const tokens = z.object({ id_token: z.string().max(32768), access_token: z.string().max(16384).optional() })
    .parse(JSON.parse(await enterpriseFetch(config.token_endpoint, config.trusted_origins,
      { method: 'POST', headers, body: body.toString() })));
  const header = decodeProtectedHeader(tokens.id_token);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AppError('UNAUTHORIZED', 401, 'SSO_SIGNATURE_INVALID');
  // One bounded fetch per callback, with start/callback rate limits; no unbounded unknown-kid retry.
  const jwks = JSON.parse(await enterpriseFetch(config.jwks_uri, config.trusted_origins)) as {
    keys: Array<{ kid?: string; kty: string; n?: string; e?: string; alg?: string; use?: string; d?: string }>;
  };
  if (!Array.isArray(jwks.keys) || jwks.keys.length > 20) throw new AppError('UNAUTHORIZED', 401, 'SSO_JWKS_INVALID');
  const selected = jwks.keys.filter((key) => key.kid === header.kid);
  const key = selected[0];
  if (selected.length !== 1 || key.kty !== 'RSA' || key.d !== undefined || !key.n || !key.e ||
    (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig')) {
    throw new AppError('UNAUTHORIZED', 401, 'SSO_JWKS_INVALID');
  }
  try {
    const bits = createPublicKey({ key, format: 'jwk' }).asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < 2048 || bits > 8192) throw new Error();
  } catch { throw new AppError('UNAUTHORIZED', 401, 'SSO_JWKS_INVALID'); }
  const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet({ keys: selected }), {
    algorithms: ['RS256'], issuer: config.issuer, audience: config.client_id,
    clockTolerance: MAX_AUTH_AGE_SKEW, requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce'],
  });
  return validateEnterpriseOidcClaims(connection, payload, flow.nonce, tokens.access_token);
}
