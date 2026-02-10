import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import * as QRCode from 'qrcode';

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

function base32Decode(secret: string): Uint8Array {
  assertTotpSecretValid(secret);
  const s = secret.trim();

  // RFC 4648 base32 decode (no padding).
  const out: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;

  for (const ch of s) {
    const code = ch.charCodeAt(0);
    let val = -1;

    if (code >= 65 && code <= 90) {
      // A-Z
      val = code - 65;
    } else if (code >= 50 && code <= 55) {
      // 2-7
      val = 26 + (code - 50);
    }

    if (val < 0) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_SECRET');

    buffer = (buffer << 5) | val;
    bitsLeft += 5;

    while (bitsLeft >= 8) {
      out.push((buffer >> (bitsLeft - 8)) & 255);
      bitsLeft -= 8;
      buffer &= (1 << bitsLeft) - 1;
    }
  }

  return Uint8Array.from(out);
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

function assertTotpCodeValid(code: string, digits: 6 | 8): void {
  if (typeof code !== 'string') throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_CODE');
  const trimmed = code.trim();
  if (trimmed.length !== digits) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_CODE');
  if (!/^[0-9]+$/.test(trimmed)) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_CODE');
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

function toCryptoAlgorithm(algorithm: 'SHA1' | 'SHA256' | 'SHA512'): 'sha1' | 'sha256' | 'sha512' {
  if (algorithm === 'SHA1') return 'sha1';
  if (algorithm === 'SHA256') return 'sha256';
  return 'sha512';
}

function computeTotp(params: {
  secret: string;
  nowMs: number;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8;
  period: number;
}): string {
  const secretBytes = base32Decode(params.secret);

  const period = params.period;
  if (!Number.isFinite(period) || period <= 0) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_PERIOD');

  const nowMs = params.nowMs;
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_TIME');

  const counter = BigInt(Math.floor(nowMs / 1000 / period));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);

  const mac = createHmac(toCryptoAlgorithm(params.algorithm), Buffer.from(secretBytes))
    .update(counterBuf)
    .digest();

  // Dynamic truncation (RFC 4226/6238).
  const offset = mac[mac.length - 1]! & 0x0f;
  const binCode =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  const mod = params.digits === 8 ? 100_000_000 : 1_000_000;
  const otp = binCode % mod;
  return String(otp).padStart(params.digits, '0');
}

/**
 * Brief 13 / Phase 8.4: verify the initial TOTP code during setup.
 *
 * For UX, we allow a small time skew window (default +/- 1 step).
 * Callers are responsible for rate limiting and generic user-facing errors.
 */
export function verifyTotpCode(params: {
  secret: string;
  code: string;
  now?: Date;
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
  digits?: 6 | 8;
  period?: number;
  window?: number;
}): boolean {
  const algorithm = params.algorithm ?? 'SHA1';
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;
  const window = params.window ?? 1;

  assertTotpCodeValid(params.code, digits);
  assertTotpSecretValid(params.secret);

  if (!Number.isInteger(window) || window < 0 || window > 5) {
    // Keep the allowed skew bounded to avoid accidental large acceptance windows.
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_WINDOW');
  }

  const baseNowMs = (params.now ?? new Date()).getTime();
  const expected = Buffer.from(params.code.trim(), 'utf8');

  for (let step = -window; step <= window; step += 1) {
    const candidate = computeTotp({
      secret: params.secret,
      nowMs: baseNowMs + step * period * 1000,
      algorithm,
      digits,
      period,
    });

    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (candidateBuf.length !== expected.length) continue;
    if (timingSafeEqual(candidateBuf, expected)) return true;
  }

  return false;
}

/**
 * Brief 13 / Phase 8.3: render a scannable QR code for authenticator enrollment.
 *
 * Returns a `data:image/svg+xml;base64,...` URL suitable for `<img src="...">`.
 */
export async function renderTotpQrCodeDataUrl(params: {
  otpAuthUri: string;
}): Promise<string> {
  const value = (params.otpAuthUri ?? '').trim();
  if (!value) throw new AppError('BAD_REQUEST', 400, 'INVALID_OTPAUTH_URI');
  if (!value.startsWith('otpauth://')) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_OTPAUTH_URI');
  }

  const svg = await QRCode.toString(value, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 4,
  });

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
