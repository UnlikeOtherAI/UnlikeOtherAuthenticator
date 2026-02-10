import { randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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

