import { createHash, createHmac, randomBytes } from 'node:crypto';

import { requireEnv } from '../config/env.js';
import { normalizeDomain } from './domain.js';

export function generateClientSecret(): string {
  return randomBytes(36).toString('base64url');
}

export function createDomainClientHash(domain: string, clientSecret: string): string {
  return createHash('sha256').update(`${normalizeDomain(domain)}${clientSecret}`).digest('hex');
}

export function digestDomainClientHash(
  clientHash: string,
  pepper = requireEnv('SHARED_SECRET').SHARED_SECRET,
): string {
  return createHmac('sha256', pepper).update(clientHash, 'utf8').digest('hex');
}
