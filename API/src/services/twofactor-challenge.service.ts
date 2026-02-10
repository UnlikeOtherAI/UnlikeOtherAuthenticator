import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import { TWOFA_CHALLENGE_TTL_MS } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

const TWOFA_CHALLENGE_ALLOWED_ALGS = ['HS256'] as const;

const TwoFaChallengeSchema = z.object({
  sub: z.string().min(1),
  config_url: z.string().min(1),
  redirect_url: z.string().min(1),
  domain: z.string().min(1),
  auth_method: z.string().min(1),
});

export type TwoFaChallenge = {
  userId: string;
  configUrl: string;
  redirectUrl: string;
  domain: string;
  authMethod: string;
};

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

/**
 * Brief 13 / Phase 8.6: issue a short-lived, signed 2FA challenge token after
 * primary authentication (password or social) succeeds.
 *
 * This token is a bearer secret; keep TTL short and never log it.
 */
export async function signTwoFaChallenge(params: {
  userId: string;
  configUrl: string;
  redirectUrl: string;
  domain: string;
  authMethod: string;
  sharedSecret: string;
  audience: string;
  now?: Date;
  ttlMs?: number;
}): Promise<string> {
  const now = params.now ?? new Date();
  const ttlMs = params.ttlMs ?? TWOFA_CHALLENGE_TTL_MS;
  const expSeconds = Math.floor((now.getTime() + ttlMs) / 1000);

  try {
    return await new SignJWT({
      config_url: params.configUrl,
      redirect_url: params.redirectUrl,
      domain: params.domain,
      auth_method: params.authMethod,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setAudience(params.audience)
      .setSubject(params.userId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(expSeconds)
      .sign(sharedSecretKey(params.sharedSecret));
  } catch {
    throw new AppError('INTERNAL', 500, 'TWOFA_CHALLENGE_SIGN_FAILED');
  }
}

export async function verifyTwoFaChallenge(params: {
  token: string;
  sharedSecret: string;
  audience: string;
  now?: Date;
}): Promise<TwoFaChallenge> {
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(params.token, sharedSecretKey(params.sharedSecret), {
      algorithms: [...TWOFA_CHALLENGE_ALLOWED_ALGS],
      audience: params.audience,
      currentDate: params.now,
    });
    payload = res.payload;
  } catch {
    // Treat as generic auth failure; never leak "expired token" vs "bad signature", etc.
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  let parsed: z.infer<typeof TwoFaChallengeSchema>;
  try {
    parsed = TwoFaChallengeSchema.parse(payload);
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  return {
    userId: parsed.sub,
    configUrl: parsed.config_url,
    redirectUrl: parsed.redirect_url,
    domain: parsed.domain,
    authMethod: parsed.auth_method,
  };
}
