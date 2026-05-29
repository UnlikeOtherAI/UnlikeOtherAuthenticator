import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { SOCIAL_STATE_TTL_MS } from '../../config/constants.js';

// Name of the signed, HttpOnly cookie that binds the social OAuth `state` to the
// browser that initiated the flow. Scoped to /auth so it survives the provider's
// top-level redirect back to /auth/callback but is not sent to unrelated paths.
export const SOCIAL_STATE_COOKIE_NAME = 'uoa_social_state';

const COOKIE_PATH = '/auth';

// CSPRNG nonce embedded in the state JWT and mirrored in the cookie.
export function generateSocialStateNonce(): string {
  return randomBytes(32).toString('base64url');
}

function cookieBaseOptions(): {
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: string;
  signed: true;
} {
  return {
    httpOnly: true,
    // SameSite=Lax is required so the cookie survives the provider's top-level
    // GET redirect back to the callback. Secure keeps it HTTPS-only.
    secure: true,
    sameSite: 'lax',
    path: COOKIE_PATH,
    signed: true,
  };
}

export function setSocialStateCookie(reply: FastifyReply, nonce: string): void {
  reply.setCookie(SOCIAL_STATE_COOKIE_NAME, nonce, {
    ...cookieBaseOptions(),
    maxAge: Math.floor(SOCIAL_STATE_TTL_MS / 1000),
  });
}

// Single-use: always clear the cookie once the callback has consumed it.
export function clearSocialStateCookie(reply: FastifyReply): void {
  reply.clearCookie(SOCIAL_STATE_COOKIE_NAME, { ...cookieBaseOptions(), maxAge: 0 });
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
