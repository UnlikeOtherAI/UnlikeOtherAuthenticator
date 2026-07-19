import { createHash, randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import { LOGIN_SESSION_TTL_MS } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';

const LOGIN_SESSION_ALLOWED_ALGS = ['HS256'] as const;
const LOGIN_SESSION_ISSUER = 'uoa:login-session';
const LOGIN_SESSION_TYP = 'login_session';

const LoginSessionSchema = z
  .object({
    sub: z.string().min(1),
    domain: z.string().min(1),
    typ: z.literal(LOGIN_SESSION_TYP),
    config_url: z.string().min(1),
    config_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    redirect_url: z.string().min(1),
    code_challenge: z.string().min(1).optional(),
    code_challenge_method: z.literal('S256').optional(),
    remember_me: z.boolean(),
    request_access: z.boolean(),
    jti: z.string().min(1).max(256),
    exp: z.number().int().positive(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.code_challenge) !== Boolean(value.code_challenge_method)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PKCE challenge and method must be supplied together',
      });
    }
  });

export type LoginSession = {
  userId: string;
  domain: string;
  configUrl: string;
  configFingerprint: string;
  redirectUrl: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  rememberMe: boolean;
  requestAccess: boolean;
  jti: string;
  expiresAtEpochSeconds: number;
};

type LoginContinuation = {
  config: ClientConfig;
  configUrl: string;
  redirectUrl: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  rememberMe: boolean;
  requestAccess: boolean;
};

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const serialized = canonicalJson(record[key]);
        return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash the verified, parsed config semantics. JWT envelope fields such as iat,
 * exp, and signature bytes are absent from ClientConfig, while parsed defaults
 * and the database-backed redirect allow-list are included.
 */
export function fingerprintClientConfig(config: ClientConfig): string {
  return createHash('sha256').update(canonicalJson(config) ?? '', 'utf8').digest('hex');
}

function rejectLoginSession(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

/**
 * Mint the short-lived chooser capability only after identity verification.
 * It captures the exact authorization continuation so the chooser cannot
 * retarget the verified login to another client flow.
 */
export async function signLoginSession(
  params: LoginContinuation & {
    userId: string;
    sharedSecret: string;
    audience: string;
    now?: Date;
    ttlMs?: number;
    jti?: string;
  },
): Promise<string> {
  const now = params.now ?? new Date();
  const ttlMs = params.ttlMs ?? LOGIN_SESSION_TTL_MS;
  const expSeconds = Math.floor((now.getTime() + ttlMs) / 1000);
  const jti = params.jti ?? randomUUID();

  if (
    !jti ||
    !Number.isFinite(expSeconds) ||
    Boolean(params.codeChallenge) !== Boolean(params.codeChallengeMethod)
  ) {
    throw new AppError('INTERNAL', 500, 'LOGIN_SESSION_SIGN_FAILED');
  }

  try {
    return await new SignJWT({
      domain: params.config.domain,
      typ: LOGIN_SESSION_TYP,
      config_url: params.configUrl,
      config_fingerprint: fingerprintClientConfig(params.config),
      redirect_url: params.redirectUrl,
      code_challenge: params.codeChallenge,
      code_challenge_method: params.codeChallengeMethod,
      remember_me: params.rememberMe,
      request_access: params.requestAccess,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(LOGIN_SESSION_ISSUER)
      .setAudience(params.audience)
      .setSubject(params.userId)
      .setJti(jti)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(expSeconds)
      .sign(sharedSecretKey(params.sharedSecret));
  } catch {
    throw new AppError('INTERNAL', 500, 'LOGIN_SESSION_SIGN_FAILED');
  }
}

/**
 * Verify signature/purpose/expiry plus the current URL's verified config
 * semantics. Request-specific continuation fields are returned from the token
 * and must be used at finalization.
 */
export async function verifyLoginSession(
  params: {
    token: string;
    config: ClientConfig;
    configUrl: string;
    sharedSecret: string;
    audience: string;
    now?: Date;
  },
): Promise<LoginSession> {
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(params.token, sharedSecretKey(params.sharedSecret), {
      algorithms: [...LOGIN_SESSION_ALLOWED_ALGS],
      issuer: LOGIN_SESSION_ISSUER,
      audience: params.audience,
      currentDate: params.now,
    });
    payload = res.payload;
  } catch {
    rejectLoginSession();
  }

  let parsed: z.infer<typeof LoginSessionSchema>;
  try {
    parsed = LoginSessionSchema.parse(payload);
  } catch {
    rejectLoginSession();
  }

  if (
    parsed.domain !== params.config.domain ||
    parsed.config_url !== params.configUrl ||
    parsed.config_fingerprint !== fingerprintClientConfig(params.config)
  ) {
    rejectLoginSession();
  }

  return {
    userId: parsed.sub,
    domain: parsed.domain,
    configUrl: parsed.config_url,
    configFingerprint: parsed.config_fingerprint,
    redirectUrl: parsed.redirect_url,
    codeChallenge: parsed.code_challenge,
    codeChallengeMethod: parsed.code_challenge_method,
    rememberMe: parsed.remember_me,
    requestAccess: parsed.request_access,
    jti: parsed.jti,
    expiresAtEpochSeconds: parsed.exp,
  };
}

/** Reject any caller-controlled attempt to change a signed continuation field. */
export function assertLoginSessionContinuation(
  session: LoginSession,
  requested: {
    redirectUrl: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    rememberMe?: boolean;
    requestAccess: boolean;
  },
): void {
  if (
    session.redirectUrl !== requested.redirectUrl ||
    session.codeChallenge !== requested.codeChallenge ||
    session.codeChallengeMethod !== requested.codeChallengeMethod ||
    session.requestAccess !== requested.requestAccess ||
    (requested.rememberMe !== undefined && session.rememberMe !== requested.rememberMe)
  ) {
    rejectLoginSession();
  }
}
