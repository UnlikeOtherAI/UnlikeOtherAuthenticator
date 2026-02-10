import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { AppError } from './errors.js';

const VERSION = 'v1';
const ALG = 'aes-256-gcm';
const IV_BYTES = 12; // Recommended size for GCM.
const KEY_BYTES = 32; // AES-256.

function deriveKey(sharedSecret: string): Buffer {
  const ikm = Buffer.from(sharedSecret, 'utf8');
  // Derive a purpose-specific key from the shared secret so we don't reuse it directly.
  // Note: This is stable across restarts; it must be to decrypt stored secrets.
  const salt = Buffer.from('uoa-twofa-secret', 'utf8');
  const info = Buffer.from('uoa-twofa-secret-v1', 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, KEY_BYTES));
}

function splitEncrypted(value: string): { iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const trimmed = (value ?? '').trim();
  const parts = trimmed.split(':');
  if (parts.length !== 4) throw new AppError('INTERNAL', 500, 'INVALID_ENCRYPTED_TOTP_SECRET');

  const [version, ivB64, ctB64, tagB64] = parts;
  if (version !== VERSION) throw new AppError('INTERNAL', 500, 'INVALID_ENCRYPTED_TOTP_SECRET');

  try {
    const iv = Buffer.from(ivB64!, 'base64');
    const ciphertext = Buffer.from(ctB64!, 'base64');
    const tag = Buffer.from(tagB64!, 'base64');

    if (iv.length !== IV_BYTES) throw new AppError('INTERNAL', 500, 'INVALID_ENCRYPTED_TOTP_SECRET');
    if (tag.length !== 16) throw new AppError('INTERNAL', 500, 'INVALID_ENCRYPTED_TOTP_SECRET');
    if (ciphertext.length === 0)
      throw new AppError('INTERNAL', 500, 'INVALID_ENCRYPTED_TOTP_SECRET');

    return { iv, ciphertext, tag };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('INTERNAL', 500, 'INVALID_ENCRYPTED_TOTP_SECRET');
  }
}

/**
 * Brief 15: store `2fa_secret` encrypted at rest.
 *
 * We use AES-256-GCM with a random IV and a key derived from `SHARED_SECRET`.
 * Format: `v1:<iv_b64>:<ciphertext_b64>:<tag_b64>`
 */
export function encryptTwoFaSecret(params: { secret: string; sharedSecret: string }): string {
  const secret = (params.secret ?? '').trim();
  if (!secret) throw new AppError('BAD_REQUEST', 400, 'INVALID_TOTP_SECRET');

  const key = deriveKey(params.sharedSecret);
  const iv = randomBytes(IV_BYTES);

  try {
    const cipher = createCipheriv(ALG, key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${iv.toString('base64')}:${ciphertext.toString('base64')}:${tag.toString('base64')}`;
  } catch {
    throw new AppError('INTERNAL', 500, 'TOTP_SECRET_ENCRYPT_FAILED');
  }
}

export function decryptTwoFaSecret(params: {
  encryptedSecret: string;
  sharedSecret: string;
}): string {
  const { iv, ciphertext, tag } = splitEncrypted(params.encryptedSecret);
  const key = deriveKey(params.sharedSecret);

  try {
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
    const trimmed = plaintext.trim();
    if (!trimmed) throw new AppError('INTERNAL', 500, 'INVALID_ENCRYPTED_TOTP_SECRET');
    return trimmed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('INTERNAL', 500, 'TOTP_SECRET_DECRYPT_FAILED');
  }
}

