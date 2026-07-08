import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import { LOGIN_SESSION_TTL_MS } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

const LOGIN_SESSION_ALLOWED_ALGS = ['HS256'] as const;
const LOGIN_SESSION_ISSUER = 'uoa:login-session';
const LOGIN_SESSION_TYP = 'login_session';

const LoginSessionSchema = z.object({
  sub: z.string().min(1),
  domain: z.string().min(1),
  typ: z.literal(LOGIN_SESSION_TYP),
});

export type LoginSession = {
  userId: string;
  domain: string;
};

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

/**
 * Phase 3b (design §4.3, §8): the `login_token` bridge — a short-lived, signed HS256 JWT minted
 * after a user's identity has been verified (email code or magic link), authorizing ONLY workspace
 * selection (`POST /auth/select-team`) for that user. Mirrors `signTwoFaChallenge` exactly, but with
 * a distinct issuer/audience/`typ` so a `login_token` can never be confused with an access token or
 * a 2FA challenge token.
 */
export async function signLoginSession(params: {
  userId: string;
  domain: string;
  sharedSecret: string;
  audience: string;
  now?: Date;
  ttlMs?: number;
}): Promise<string> {
  const now = params.now ?? new Date();
  const ttlMs = params.ttlMs ?? LOGIN_SESSION_TTL_MS;
  const expSeconds = Math.floor((now.getTime() + ttlMs) / 1000);

  try {
    return await new SignJWT({
      domain: params.domain,
      typ: LOGIN_SESSION_TYP,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(LOGIN_SESSION_ISSUER)
      .setAudience(params.audience)
      .setSubject(params.userId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(expSeconds)
      .sign(sharedSecretKey(params.sharedSecret));
  } catch {
    throw new AppError('INTERNAL', 500, 'LOGIN_SESSION_SIGN_FAILED');
  }
}

/**
 * Verify a `login_token`. Rejects (generically, no oracle) on bad signature, wrong issuer/audience,
 * wrong `typ`, expiry, or a domain mismatch against the current config — matching
 * `verifyTwoFaChallenge`'s failure shape.
 */
export async function verifyLoginSession(params: {
  token: string;
  domain: string;
  sharedSecret: string;
  audience: string;
  now?: Date;
}): Promise<LoginSession> {
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
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  let parsed: z.infer<typeof LoginSessionSchema>;
  try {
    parsed = LoginSessionSchema.parse(payload);
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  if (parsed.domain !== params.domain) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  return { userId: parsed.sub, domain: parsed.domain };
}
