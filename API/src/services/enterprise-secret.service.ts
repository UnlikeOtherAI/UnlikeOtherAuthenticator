import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

function keyring(): { current: string; keys: Record<string, string> } {
  const raw = getEnv().ENTERPRISE_SSO_KEYRING;
  if (!raw) throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_KEY_REQUIRED');
  try {
    const parsed = JSON.parse(raw) as { current: string; keys: Record<string, string> };
    if (!parsed.current || !parsed.keys[parsed.current] ||
      Object.values(parsed.keys).some((key) => Buffer.from(key, 'base64').length !== 32)) throw new Error();
    return parsed;
  } catch { throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_KEY_REQUIRED'); }
}

/** Context is authenticated too: ciphertext cannot move between connections or credential classes. */
export function sealEnterpriseSecret(value: string, context: string): string {
  const ring = keyring();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(ring.keys[ring.current], 'base64'), nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [ring.current, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url')].join('.');
}

export function openEnterpriseSecret(value: string, context: string): string {
  try {
    const [kid, nonce, tag, encrypted, extra] = value.split('.');
    const key = keyring().keys[kid];
    if (!key || extra || !encrypted) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_UNAVAILABLE'); }
}
