import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { SOCIAL_STATE_TTL_MS } from '../../config/constants.js';
import { AppError } from '../../utils/errors.js';

// Name of the signed, HttpOnly cookie that binds the social OAuth `state` to the
// browser that initiated the flow. Scoped to /auth so it survives the provider's
// top-level redirect back to /auth/callback but is not sent to unrelated paths.
export const SOCIAL_STATE_COOKIE_NAME = 'uoa_social_state';
export const SOCIAL_INVITE_COOKIE_NAME = 'uoa_social_invite';
export const X_SOCIAL_CONTEXT_COOKIE_NAME = 'uoa_x_social_context';

const COOKIE_PATH = '/auth';

// CSPRNG nonce embedded in the state JWT and mirrored in the cookie.
export function generateSocialStateNonce(): string {
  return randomBytes(32).toString('base64url');
}

function cookieBaseOptions(provider?: string): {
  httpOnly: true;
  secure: true;
  sameSite: 'lax' | 'none';
  path: string;
  signed: true;
} {
  return {
    httpOnly: true,
    // Apple POSTs the callback from another site, so its nonce needs SameSite=None.
    // All other providers return with top-level GET redirects.
    secure: true,
    sameSite: provider === 'apple' ? 'none' : 'lax',
    path: COOKIE_PATH,
    signed: true,
  };
}

export function setSocialStateCookie(reply: FastifyReply, nonce: string, provider?: string): void {
  reply.setCookie(SOCIAL_STATE_COOKIE_NAME, nonce, {
    ...cookieBaseOptions(provider),
    maxAge: Math.floor(SOCIAL_STATE_TTL_MS / 1000),
  });
}

// Single-use: always clear the cookie once the callback has consumed it.
export function clearSocialStateCookie(reply: FastifyReply): void {
  reply.clearCookie(SOCIAL_STATE_COOKIE_NAME, { ...cookieBaseOptions(), maxAge: 0 });
}

/** Stores an invite capability only in the browser's signed, HttpOnly cookie. */
export function setSocialInviteCookie(reply: FastifyReply, token: string, provider?: string): void {
  reply.setCookie(SOCIAL_INVITE_COOKIE_NAME, token, {
    ...cookieBaseOptions(provider),
    maxAge: Math.floor(SOCIAL_STATE_TTL_MS / 1000),
  });
}

export function readSocialInviteCookie(request: FastifyRequest): string | null {
  const raw = request.cookies?.[SOCIAL_INVITE_COOKIE_NAME];
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && typeof unsigned.value === 'string' && unsigned.value.length > 0
    ? unsigned.value
    : null;
}

export function clearSocialInviteCookie(reply: FastifyReply): void {
  reply.clearCookie(SOCIAL_INVITE_COOKIE_NAME, { ...cookieBaseOptions(), maxAge: 0 });
}

/** X limits provider-visible state to 500 characters, so keep the signed JWT and PKCE verifier in this browser cookie. */
export function setXSocialContextCookie(
  reply: FastifyReply,
  context: { state: string; stateJwt: string; codeVerifier: string },
): void {
  const value = JSON.stringify(context);
  if (Buffer.byteLength(value, 'utf8') > 3500) {
    throw new AppError('BAD_REQUEST', 400, 'SOCIAL_STATE_TOO_LARGE');
  }
  reply.setCookie(X_SOCIAL_CONTEXT_COOKIE_NAME, value, {
    ...cookieBaseOptions(),
    maxAge: Math.floor(SOCIAL_STATE_TTL_MS / 1000),
  });
}

export function readXSocialContextCookie(request: FastifyRequest): {
  state: string;
  stateJwt: string;
  codeVerifier: string;
} | null {
  const raw = request.cookies?.[X_SOCIAL_CONTEXT_COOKIE_NAME];
  if (typeof raw !== 'string') return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || typeof unsigned.value !== 'string') return null;
  try {
    const value = JSON.parse(unsigned.value) as Record<string, unknown>;
    if (typeof value.state !== 'string' || typeof value.stateJwt !== 'string' ||
        typeof value.codeVerifier !== 'string') return null;
    return { state: value.state, stateJwt: value.stateJwt, codeVerifier: value.codeVerifier };
  } catch {
    return null;
  }
}

export function clearXSocialContextCookie(reply: FastifyReply): void {
  reply.clearCookie(X_SOCIAL_CONTEXT_COOKIE_NAME, { ...cookieBaseOptions(), maxAge: 0 });
}

function constantTimeEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

// Read and validate the signed cookie nonce against the nonce carried in the state
// JWT. Returns true only when a valid signed cookie is present and matches.
export function socialStateCookieMatches(request: FastifyRequest, expectedNonce: string): boolean {
  const raw = request.cookies?.[SOCIAL_STATE_COOKIE_NAME];
  if (typeof raw !== 'string' || raw.length === 0) return false;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return false;

  return constantTimeEqual(unsigned.value, expectedNonce);
}
