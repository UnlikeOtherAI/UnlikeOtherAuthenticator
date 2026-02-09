import { createHash } from 'node:crypto';

function normalizeDomain(domain: string): string {
  // Domains are case-insensitive; normalize to ensure deterministic hashing.
  return domain.trim().toLowerCase();
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Client ID = hash(domain + shared secret)
 *
 * Spec: Docs/brief.md (Client Identification & Trust Model)
 */
export function createClientId(domain: string, sharedSecret: string): string {
  const normalizedDomain = normalizeDomain(domain);
  return sha256Hex(normalizedDomain + sharedSecret);
}

