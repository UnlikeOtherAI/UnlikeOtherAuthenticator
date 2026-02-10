import {
  SignJWT,
  importPKCS8,
  importJWK,
  decodeProtectedHeader,
  jwtVerify,
  type JWK,
  type KeyLike,
  type JWTPayload,
} from 'jose';

import { AppError } from '../../utils/errors.js';
import { validateSocialProfile, type SocialProfile } from './provider.base.js';

const APPLE_AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

type AppleJwk = Record<string, unknown> & {
  kid?: string;
  use?: string;
  alg?: string;
  kty?: string;
};

let cachedAppleJwks:
  | { fetchedAtMs: number; keys: AppleJwk[] }
  | undefined;
const APPLE_JWKS_CACHE_MS = 60 * 60 * 1000; // 1h

function normalizeString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  const s = normalizeString(value);
  return s ? s : null;
}

function normalizePem(value: string): string {
  // Common deployment pattern is to store PEM with escaped newlines in env vars.
  return value.includes('\\n') ? value.replace(/\\n/g, '\n').trim() : value.trim();
}

function parseBooleanish(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  if (typeof value === 'number') return value === 1;
  return false;
}

async function fetchAppleJwksKeys(now?: Date): Promise<AppleJwk[]> {
  const nowMs = (now ?? new Date()).getTime();
  if (cachedAppleJwks && nowMs - cachedAppleJwks.fetchedAtMs < APPLE_JWKS_CACHE_MS) {
    return cachedAppleJwks.keys;
  }

  let res: Response;
  try {
    res = await fetch(APPLE_JWKS_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_JWKS_FETCH_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_JWKS_FETCH_FAILED');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_JWKS_FETCH_FAILED');
  }

  const keys = (json as Record<string, unknown> | null)?.keys;
  if (!Array.isArray(keys)) {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_JWKS_FETCH_FAILED');
  }

  const parsed = keys.filter((k) => k && typeof k === 'object') as AppleJwk[];
  cachedAppleJwks = { fetchedAtMs: nowMs, keys: parsed };
  return parsed;
}

async function resolveAppleSigningKey(params: { idToken: string }): Promise<KeyLike> {
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(params.idToken) as Record<string, unknown>;
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_ID_TOKEN_INVALID');
  }

  const kid = normalizeString(header.kid);
  if (!kid) {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_ID_TOKEN_INVALID');
  }

  const keys = await fetchAppleJwksKeys();
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_ID_TOKEN_INVALID');
  }

  // If present, enforce these constraints before importing.
  if (typeof jwk.use === 'string' && jwk.use !== 'sig') {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_ID_TOKEN_INVALID');
  }
  if (typeof jwk.alg === 'string' && jwk.alg !== 'RS256') {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_ID_TOKEN_INVALID');
  }
  if (typeof jwk.kty === 'string' && jwk.kty !== 'RSA') {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_ID_TOKEN_INVALID');
  }

  try {
    // We validated presence/shape above; cast for the jose type checker.
    return (await importJWK(jwk as unknown as JWK, 'RS256')) as KeyLike;
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_ID_TOKEN_INVALID');
  }
}

export function buildAppleAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(APPLE_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  // Request only what we need; name is only returned on first consent.
  u.searchParams.set('scope', 'openid email name');
  // Keep callback flow consistent with existing GET /auth/callback/:provider route.
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('state', params.state);
  return u.toString();
}

async function buildAppleClientSecretJwt(params: {
  teamId: string;
  clientId: string;
  keyId: string;
  privateKeyPem: string;
  now?: Date;
  ttlSeconds?: number;
}): Promise<string> {
  const now = params.now ?? new Date();
  const ttlSeconds = params.ttlSeconds ?? 300;

  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(normalizePem(params.privateKeyPem), 'ES256');
  } catch {
    throw new AppError('INTERNAL', 500, 'APPLE_PRIVATE_KEY_INVALID');
  }

  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttlSeconds;

  try {
    return await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: params.keyId, typ: 'JWT' })
      .setIssuer(params.teamId)
      .setSubject(params.clientId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key);
  } catch {
    throw new AppError('INTERNAL', 500, 'APPLE_CLIENT_SECRET_SIGN_FAILED');
  }
}

async function exchangeCodeForIdToken(params: {
  code: string;
  clientId: string;
  clientSecretJwt: string;
  redirectUri: string;
}): Promise<{ idToken: string }> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', params.code);
  body.set('client_id', params.clientId);
  body.set('client_secret', params.clientSecretJwt);
  body.set('redirect_uri', params.redirectUri);

  let res: Response;
  try {
    res = await fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_TOKEN_EXCHANGE_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_TOKEN_EXCHANGE_FAILED');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_TOKEN_EXCHANGE_FAILED');
  }

  const idToken = normalizeString((json as Record<string, unknown> | null)?.id_token);
  if (!idToken) {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_TOKEN_EXCHANGE_FAILED');
  }

  return { idToken };
}

async function verifyAppleIdToken(params: {
  idToken: string;
  clientId: string;
}): Promise<JWTPayload> {
  const key = await resolveAppleSigningKey({ idToken: params.idToken });
  try {
    const { payload } = await jwtVerify(params.idToken, key, {
      issuer: APPLE_ISSUER,
      audience: params.clientId,
      algorithms: ['RS256'],
    });
    return payload;
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_ID_TOKEN_INVALID');
  }
}

export async function getAppleProfileFromCode(params: {
  code: string;
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  redirectUri: string;
}): Promise<SocialProfile> {
  const clientSecretJwt = await buildAppleClientSecretJwt({
    teamId: params.teamId,
    clientId: params.clientId,
    keyId: params.keyId,
    privateKeyPem: params.privateKeyPem,
  });

  const { idToken } = await exchangeCodeForIdToken({
    code: params.code,
    clientId: params.clientId,
    clientSecretJwt,
    redirectUri: params.redirectUri,
  });

  const payload = await verifyAppleIdToken({ idToken, clientId: params.clientId });
  const obj = (payload ?? {}) as Record<string, unknown>;

  const email = normalizeString(obj.email);
  if (!email) {
    // Email is the canonical identifier (brief section 2); fail closed if Apple doesn't provide one.
    throw new AppError('UNAUTHORIZED', 401, 'APPLE_EMAIL_MISSING');
  }

  return validateSocialProfile({
    provider: 'apple',
    email,
    emailVerified: parseBooleanish(obj.email_verified),
    name: normalizeOptionalString(obj.name),
    avatarUrl: null,
  });
}
