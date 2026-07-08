import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import { TWOFA_SETUP_TTL_MS } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

const TWOFA_SETUP_ALLOWED_ALGS = ['HS256'] as const;
const TWOFA_SETUP_ISSUER = 'uoa:twofa-setup';

const TwoFaSetupSchema = z.object({
  sub: z.string().min(1),
  encrypted_secret: z.string().min(1),
  config_url: z.string().min(1),
  domain: z.string().min(1),
  auth_method: z.string().min(1).optional(),
  redirect_url: z.string().min(1).optional(),
  remember_me: z.boolean().optional(),
  request_access: z.boolean().optional(),
  code_challenge: z.string().min(1).optional(),
  code_challenge_method: z.literal('S256').optional(),
  // Workspace scope carried through from /auth/select-team (Phase 3b, design §4.4). Absent for
  // every pre-existing caller — unchanged behaviour.
  org_id: z.string().min(1).optional(),
  team_id: z.string().min(1).optional(),
});

export type TwoFaSetupToken = {
  userId: string;
  encryptedSecret: string;
  configUrl: string;
  domain: string;
  authMethod?: string;
  redirectUrl?: string;
  rememberMe: boolean;
  requestAccess: boolean;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  orgId?: string;
  teamId?: string;
};

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

export async function signTwoFaSetupToken(params: {
  userId: string;
  encryptedSecret: string;
  configUrl: string;
  domain: string;
  authMethod?: string;
  redirectUrl?: string;
  rememberMe?: boolean;
  requestAccess?: boolean;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  orgId?: string;
  teamId?: string;
  sharedSecret: string;
  audience: string;
  now?: Date;
  ttlMs?: number;
}): Promise<string> {
  const now = params.now ?? new Date();
  const ttlMs = params.ttlMs ?? TWOFA_SETUP_TTL_MS;
  const expSeconds = Math.floor((now.getTime() + ttlMs) / 1000);

  try {
    return await new SignJWT({
      encrypted_secret: params.encryptedSecret,
      config_url: params.configUrl,
      domain: params.domain,
      auth_method: params.authMethod,
      redirect_url: params.redirectUrl,
      remember_me: params.rememberMe ?? false,
      request_access: params.requestAccess ?? false,
      code_challenge: params.codeChallenge,
      code_challenge_method: params.codeChallengeMethod,
      org_id: params.orgId,
      team_id: params.teamId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(TWOFA_SETUP_ISSUER)
      .setAudience(params.audience)
      .setSubject(params.userId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(expSeconds)
      .sign(sharedSecretKey(params.sharedSecret));
  } catch {
    throw new AppError('INTERNAL', 500, 'TWOFA_SETUP_SIGN_FAILED');
  }
}

export async function verifyTwoFaSetupToken(params: {
  token: string;
  sharedSecret: string;
  audience: string;
  now?: Date;
}): Promise<TwoFaSetupToken> {
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(params.token, sharedSecretKey(params.sharedSecret), {
      algorithms: [...TWOFA_SETUP_ALLOWED_ALGS],
      issuer: TWOFA_SETUP_ISSUER,
      audience: params.audience,
      currentDate: params.now,
    });
    payload = res.payload;
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  let parsed: z.infer<typeof TwoFaSetupSchema>;
  try {
    parsed = TwoFaSetupSchema.parse(payload);
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  const token: TwoFaSetupToken = {
    userId: parsed.sub,
    encryptedSecret: parsed.encrypted_secret,
    configUrl: parsed.config_url,
    domain: parsed.domain,
    rememberMe: parsed.remember_me ?? false,
    requestAccess: parsed.request_access ?? false,
  };
  if (parsed.auth_method) token.authMethod = parsed.auth_method;
  if (parsed.redirect_url) token.redirectUrl = parsed.redirect_url;
  if (parsed.code_challenge) {
    token.codeChallenge = parsed.code_challenge;
    token.codeChallengeMethod = parsed.code_challenge_method;
  }
  if (parsed.org_id) token.orgId = parsed.org_id;
  if (parsed.team_id) token.teamId = parsed.team_id;
  return token;
}
