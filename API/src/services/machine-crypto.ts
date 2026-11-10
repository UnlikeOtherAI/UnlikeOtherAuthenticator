import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { calculateJwkThumbprint } from 'jose';
import { getPublicBaseUrl, requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { checkedMachinePublicKey } from './machine-public-key.js';

export const machineHash = (value: string): string => createHash('sha256').update(value).digest('hex');
/** RFC 8785's bounded profile: strict wire records contain strings, booleans,
 * null and safe integers only. Undefined optional properties are omitted. */
export function machineCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    // I-JSON refuses lone UTF-16 surrogates rather than replacing their bytes.
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) machineRefused(400);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) machineRefused(400);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(machineCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).filter(key => row[key] !== undefined).sort()
      .map(key => `${machineCanonicalJson(key)}:${machineCanonicalJson(row[key])}`).join(',')}}`;
  }
  return machineRefused(400);
}
export const machineMac = (purpose: string, value: string): string =>
  createHmac('sha256', requireEnv('SHARED_SECRET').SHARED_SECRET)
    .update(`uoa.machine.${purpose}.v1\0`).update(value).digest('base64url');
export function machineEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function machineRefused(status = 401, code = 'MACHINE_PROOF_INVALID'): never {
  throw new AppError(status >= 500 ? 'SERVICE_UNAVAILABLE' : 'UNAUTHORIZED', status, code);
}
export function machineCredential(enrollment: string, authorization: string, generation: number, operation: string): string {
  return `uoa_machine_${machineMac('credential', JSON.stringify([enrollment, authorization, generation, operation]))}`;
}
export async function machineThumbprint(value: unknown): Promise<string> {
  const key = checkedMachinePublicKey(value);
  createPublicKey({ key, format: 'jwk' });
  return calculateJwkThumbprint(key);
}
export function verifyMachineProof(key: unknown, transcript: string, signature: string): void {
  try {
    const bytes = Buffer.from(signature, 'base64url');
    if (bytes.length !== 64 || bytes.toString('base64url') !== signature ||
      !verify(null, Buffer.from(transcript, 'utf8'), createPublicKey({ key: checkedMachinePublicKey(key), format: 'jwk' }), bytes)) {
      machineRefused();
    }
  } catch { machineRefused(); }
}
export function machineTranscript(input: { domain: string; operation: string; requestId: string;
  requestHash: string; challengeId: string; expiresAt: Date }): string {
  return 'UOA-MACHINE-POP-V1\n' + JSON.stringify({ version: 1, issuer: getPublicBaseUrl(),
    client_domain: input.domain, operation: input.operation, request_id: input.requestId,
    request_hash: input.requestHash, challenge_id: input.challengeId,
    nonce: randomBytes(32).toString('base64url'), expires_at: input.expiresAt.toISOString() });
}
