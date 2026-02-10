import { createHash, randomBytes } from 'node:crypto';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function generateEmailToken(): string {
  // 32 bytes -> 256 bits of entropy; base64url for safe transport in URLs.
  return randomBytes(32).toString('base64url');
}

export function hashEmailToken(token: string, pepper: string): string {
  // Store hashed tokens (brief 12). The token itself is random, but adding a pepper
  // keeps the stored value non-reusable even if the DB leaks.
  return sha256Hex(`${token}.${pepper}`);
}

