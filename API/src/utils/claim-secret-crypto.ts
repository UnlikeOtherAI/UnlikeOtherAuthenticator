import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { requireEnv } from '../config/env.js';
import { AppError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard
const TAG_LENGTH = 16;

// Fixed HKDF info label — namespaces the KEK to this feature so the same
// SHARED_SECRET cannot be confused with keys used elsewhere in the service.
const HKDF_INFO = Buffer.from('uoa-integration-claim-secret-v1', 'utf8');
const HKDF_SALT = Buffer.from('uoa-integration-claim-salt-v1', 'utf8');

export type EncryptedClaimSecret = {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
};

function deriveKey(sharedSecret: string): Buffer {
  const derived = hkdfSync('sha256', Buffer.from(sharedSecret, 'utf8'), HKDF_SALT, HKDF_INFO, KEY_LENGTH);
  // hkdfSync returns an ArrayBuffer in some Node versions; coerce to Buffer.
  return Buffer.from(derived as ArrayBufferLike);
}

function kek(): Buffer {
  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  return deriveKey(SHARED_SECRET);
}

export function encryptClaimSecret(
  plaintext: string,
  opts?: { sharedSecret?: string },
): EncryptedClaimSecret {
  const key = opts?.sharedSecret ? deriveKey(opts.sharedSecret) : kek();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decryptClaimSecret(
  payload: EncryptedClaimSecret,
  opts?: { sharedSecret?: string },
): string {
  if (payload.iv.length !== IV_LENGTH) {
    throw new AppError('INTERNAL', 500, 'CLAIM_CIPHERTEXT_IV_INVALID');
  }
  if (payload.tag.length !== TAG_LENGTH) {
    throw new AppError('INTERNAL', 500, 'CLAIM_CIPHERTEXT_TAG_INVALID');
  }
  const key = opts?.sharedSecret ? deriveKey(opts.sharedSecret) : kek();
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.tag);
  try {
    const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // A tampered ciphertext / tag will surface as generic integrity failure here.
    throw new AppError('INTERNAL', 500, 'CLAIM_CIPHERTEXT_INVALID');
  }
}
