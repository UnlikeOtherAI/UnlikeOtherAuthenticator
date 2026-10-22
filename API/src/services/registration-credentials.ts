import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { requireEnv } from '../config/env.js';

export const REGISTRATION_TTL_MS = 15 * 60 * 1000;
export const REGISTRATION_MAX_ATTEMPTS = 5;
export const REGISTRATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function registrationDigest(kind: string, value: string): string {
  return createHmac('sha256', requireEnv('SHARED_SECRET').SHARED_SECRET)
    .update(`registration:${kind}:${value}`).digest('hex');
}

export function registrationSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function registrationCode(): string {
  return Array.from({ length: 6 }, () => REGISTRATION_ALPHABET[randomInt(REGISTRATION_ALPHABET.length)]).join('');
}

export function equalRegistrationDigest(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function completionToken(id: string, credential: string): string {
  return `registration.${registrationDigest('completion', `${id}:${credential}`)}`;
}

export function registrationCookieName(id: string): string {
  return `uoa_registration_${id}`;
}
