import { randomBytes } from 'node:crypto';

import { AppError } from '../utils/errors.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_RE = /^[A-Z2-7]+$/;

function base32Encode(bytes: Uint8Array): string {
  // RFC 4648 base32 (no padding). Most authenticator apps expect this encoding.
  let out = '';

  let buffer = 0;
  let bitsLeft = 0;

  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bitsLeft += 8;

    while (bitsLeft >= 5) {
      const idx = (buffer >> (bitsLeft - 5)) & 31;
      out += BASE32_ALPHABET[idx]!;
      bitsLeft -= 5;

      // Keep only the remaining bits to avoid growing the buffer.
      buffer &= (1 << bitsLeft) - 1;
    }
  }

  if (bitsLeft > 0) {
    // Remaining bits (0 < bitsLeft < 5): pad with zeros to form the last base32 char.
    const idx = (buffer << (5 - bitsLeft)) & 31;
    out += BASE32_ALPHABET[idx]!;
  }

  return out;
}

/**
 * Brief 13 / Phase 8.1: generate a user-specific TOTP secret for enrollment.
 *
 * 20 bytes (160 bits) is a common, compatible default for authenticator apps.
 * The returned secret is base32 (A-Z, 2-7) with no padding.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function assertTotpSecretValid(secret: string): void {
  if (typeof secret !== 'string') throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_SECRET');
  const trimmed = secret.trim();
  if (!trimmed) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_SECRET');
  if (!BASE32_RE.test(trimmed)) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_SECRET');
}

/**
 * Brief 13 / Phase 8.2: generate an `otpauth://` URI from a TOTP secret.
 *
 * Keep this function pure; callers decide issuer/account values (e.g. domain + email).
 */
export function buildTotpOtpAuthUri(params: {
  secret: string;
  issuer: string;
  accountName: string;
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
  digits?: 6 | 8;
  period?: number;
}): string {
  assertTotpSecretValid(params.secret);

  const issuer = (params.issuer ?? '').trim();
  const accountName = (params.accountName ?? '').trim();
  if (!issuer) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_ISSUER');
  if (!accountName) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_ACCOUNT');

  // Label is a path segment; encode each component, keep ":" as the separator.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;

  const sp = new URLSearchParams();
  sp.set('secret', params.secret.trim());
  sp.set('issuer', issuer);

  // Optional but widely supported; makes defaults explicit.
  sp.set('algorithm', params.algorithm ?? 'SHA1');
  sp.set('digits', String(params.digits ?? 6));
  sp.set('period', String(params.period ?? 30));

  return `otpauth://totp/${label}?${sp.toString()}`;
}
