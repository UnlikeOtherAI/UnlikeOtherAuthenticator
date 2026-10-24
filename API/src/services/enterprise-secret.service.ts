import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const Envelope = z.object({ version: z.literal(2), provider: z.enum(['local', 'gcp_kms']),
  key_id: z.string().min(1), wrapped_key: z.string().min(1), nonce: z.string(), tag: z.string(),
  ciphertext: z.string() }).strict();
let kms: KeyManagementServiceClient | undefined;
function localKeyring() {
  const raw = getEnv().ENTERPRISE_SSO_KEYRING;
  if (!raw) throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_KEY_REQUIRED');
  try {
    const parsed = z.object({ current: z.string().min(1), keys: z.record(z.string(), z.string()) }).strict().parse(JSON.parse(raw));
    if (!parsed.keys[parsed.current] || Object.values(parsed.keys).some((key) => Buffer.from(key, 'base64').length !== 32)) throw new Error();
    return parsed;
  } catch { throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_KEY_REQUIRED'); }
}
function encrypt(key: Buffer, value: Buffer, context: string) {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return { nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: encrypted.toString('base64url') };
}
function decrypt(key: Buffer, body: { nonce: string; tag: string; ciphertext: string }, context: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(body.nonce, 'base64url'));
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(body.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body.ciphertext, 'base64url')), decipher.final()]);
}
function provider() {
  const selected = getEnv().ENTERPRISE_SSO_CUSTODY_PROVIDER;
  if (!selected) throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_PROVIDER_REQUIRED');
  return selected;
}

/** Fresh per-record data keys are wrapped by the explicit independent KEK provider. */
export async function sealEnterpriseSecret(value: string, context: string): Promise<string> {
  const selected = provider(); const dataKey = randomBytes(32);
  const body = encrypt(dataKey, Buffer.from(value), `data:${context}`);
  try {
    let keyId: string; let wrapped: string;
    if (selected === 'local') {
      const ring = localKeyring(); keyId = ring.current;
      wrapped = Buffer.from(JSON.stringify(encrypt(Buffer.from(ring.keys[keyId], 'base64'), dataKey,
        `wrap:${context}`))).toString('base64url');
    } else {
      const key = getEnv().ENTERPRISE_SSO_KMS_KEY;
      if (!key) throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_KEY_REQUIRED');
      kms ??= new KeyManagementServiceClient();
      const [response] = await kms.encrypt({ name: key, plaintext: dataKey,
        additionalAuthenticatedData: Buffer.from(`wrap:${context}`) }, { timeout: 5000 });
      if (!response.ciphertext || !response.name) throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_UNAVAILABLE');
      keyId = response.name; wrapped = Buffer.from(response.ciphertext as Uint8Array).toString('base64url');
    }
    return JSON.stringify({ version: 2, provider: selected, key_id: keyId, wrapped_key: wrapped, ...body });
  } finally { dataKey.fill(0); }
}

export async function openEnterpriseSecret(value: string, context: string): Promise<string> {
  let dataKey: Buffer | undefined;
  try {
    const envelope = Envelope.parse(JSON.parse(value));
    if (envelope.provider !== provider()) throw new Error('custody provider mismatch');
    if (envelope.provider === 'local') {
      const key = localKeyring().keys[envelope.key_id];
      if (!key) throw new Error('retired wrapping key');
      const wrapped = z.object({ nonce: z.string(), tag: z.string(), ciphertext: z.string() }).strict().parse(
        JSON.parse(Buffer.from(envelope.wrapped_key, 'base64url').toString('utf8')));
      dataKey = decrypt(Buffer.from(key, 'base64'), wrapped, `wrap:${context}`);
    } else {
      const key = getEnv().ENTERPRISE_SSO_KMS_KEY;
      if (!key || !envelope.key_id.startsWith(`${key}/cryptoKeyVersions/`)) throw new Error('foreign wrapping key');
      kms ??= new KeyManagementServiceClient();
      const [response] = await kms.decrypt({ name: key, ciphertext: Buffer.from(envelope.wrapped_key, 'base64url'),
        additionalAuthenticatedData: Buffer.from(`wrap:${context}`) }, { timeout: 5000 });
      if (!response.plaintext) throw new Error('missing data key');
      dataKey = Buffer.from(response.plaintext as Uint8Array);
    }
    if (dataKey.length !== 32) throw new Error('invalid data key');
    return decrypt(dataKey, envelope, `data:${context}`).toString('utf8');
  } catch { throw new AppError('SERVICE_UNAVAILABLE', 503, 'SSO_CUSTODY_UNAVAILABLE'); }
  finally { dataKey?.fill(0); }
}
