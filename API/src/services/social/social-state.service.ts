import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import { SOCIAL_STATE_TTL_MS } from '../../config/constants.js';
import { AppError } from '../../utils/errors.js';
import type { SocialProviderKey } from './provider.base.js';

const SOCIAL_STATE_ALLOWED_ALGS = ['HS256'] as const;

const SocialStateSchema = z
  .object({
    provider: z.enum(['google', 'apple', 'facebook', 'github', 'linkedin']),
    config_url: z.string().min(1),
    redirect_url: z.string().min(1),
    request_access: z.boolean().optional(),
    code_challenge: z.string().min(1).optional(),
    code_challenge_method: z.literal('S256').optional(),
  });

export type SocialState = z.infer<typeof SocialStateSchema>;

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export async function signSocialState(params: {
  provider: SocialProviderKey;
  configUrl: string;
  redirectUrl: string;
  requestAccess?: boolean;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  sharedSecret: string;
  audience: string;
  baseUrlForIssuer: string;
  now?: Date;
  ttlMs?: number;
}): Promise<string> {
  const now = params.now ?? new Date();
  const ttlMs = params.ttlMs ?? SOCIAL_STATE_TTL_MS;
  const expSeconds = Math.floor((now.getTime() + ttlMs) / 1000);

  try {
    return await new SignJWT({
      provider: params.provider,
      config_url: params.configUrl,
      redirect_url: params.redirectUrl,
      request_access: params.requestAccess ?? false,
      code_challenge: params.codeChallenge,
      code_challenge_method: params.codeChallengeMethod,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setAudience(params.audience)
      .setIssuer(`${normalizeBaseUrl(params.baseUrlForIssuer)}/social-state`)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(expSeconds)
      .sign(sharedSecretKey(params.sharedSecret));
  } catch {
    throw new AppError('INTERNAL', 500, 'SOCIAL_STATE_SIGN_FAILED');
  }
}

export async function verifySocialState(params: {
  stateJwt: string;
  sharedSecret: string;
  audience: string;
  issuer: string;
  now?: Date;
}): Promise<SocialState> {
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(params.stateJwt, sharedSecretKey(params.sharedSecret), {
      algorithms: [...SOCIAL_STATE_ALLOWED_ALGS],
      audience: params.audience,
      issuer: params.issuer,
      currentDate: params.now,
    });
    payload = res.payload;
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SOCIAL_STATE');
  }

  try {
    return SocialStateSchema.parse(payload);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SOCIAL_STATE');
  }
}
