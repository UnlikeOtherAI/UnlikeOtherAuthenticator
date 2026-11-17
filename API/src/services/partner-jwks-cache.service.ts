import { errors as joseErrors } from 'jose';

import { getEnv } from '../config/env.js';
import type { PublicRsaJwks } from './client-jwk.service.js';
import { fetchPartnerJwks } from './jwks-fetch.service.js';

/**
 * A product's public signing keys, kept for a minute.
 *
 * Every signed subject assertion used to cost one HTTPS round trip to the
 * product for its JWKS: a DNS lookup, a new TLS connection and the request,
 * inside the product-API slot the caller was already holding. A product backend
 * sends dozens of assertions a second, all signed by the same key.
 *
 * What is kept is public key material only. Every assertion is still verified,
 * so nothing here is a trust decision; the one thing that ages is how soon a key
 * the product REMOVED stops being accepted:
 *
 * - A kept set is used for at most `PARTNER_JWKS_CACHE_SECONDS` (default 60, the
 *   longest a subject assertion itself may live; 0 keeps nothing).
 * - A token the kept set cannot verify (an unknown `kid`, or a signature that
 *   does not match the kept key) asks the product again before it is refused,
 *   so a rotation takes effect on the first token signed by the new key. That
 *   second read happens at most once per `PARTNER_JWKS_REFRESH_COOLDOWN_MS`,
 *   so a stream of bad tokens cannot turn into a stream of fetches.
 * - A failed fetch is never kept, and never answered from an older copy: when
 *   the keys have to be read and cannot be, the caller gets the same
 *   `INTEGRATION_JWKS_UNAVAILABLE` as before.
 *
 * Per process, bounded, and never written anywhere.
 */
export const PARTNER_JWKS_REFRESH_COOLDOWN_MS = 5_000;
const MAX_KEPT_SETS = 64;

type KeptSet = { jwks: PublicRsaJwks; fetchedAt: number };
type JwksOptions = { expectedHost?: string };

const kept = new Map<string, KeptSet>();
const inFlight = new Map<string, Promise<PublicRsaJwks>>();

/** The key a token names is not in the set. */
export class UnknownPartnerKeyError extends Error {}

function keyOf(jwksUrl: string, options: JwksOptions): string {
  return `${options.expectedHost ?? ''}\n${jwksUrl}`;
}

function fetchAndKeep(key: string, jwksUrl: string, options: JwksOptions): Promise<PublicRsaJwks> {
  const pending = inFlight.get(key);
  if (pending) return pending;

  const read = fetchPartnerJwks(jwksUrl, options)
    .then((jwks) => {
      kept.delete(key);
      kept.set(key, { jwks, fetchedAt: Date.now() });
      while (kept.size > MAX_KEPT_SETS) {
        const oldest = kept.keys().next();
        if (oldest.done) break;
        kept.delete(oldest.value);
      }
      return jwks;
    })
    .finally(() => {
      if (inFlight.get(key) === read) inFlight.delete(key);
    });
  inFlight.set(key, read);
  return read;
}

function isKeyMismatch(error: unknown): boolean {
  return (
    error instanceof UnknownPartnerKeyError ||
    error instanceof joseErrors.JWSSignatureVerificationFailed
  );
}

/**
 * Run `verify` against the product's keys: the kept set while it is recent
 * enough, the product's current set otherwise. A key mismatch against a kept
 * set is retried once against a set read now.
 */
export async function verifyWithPartnerJwks<T>(
  jwksUrl: string,
  options: JwksOptions,
  verify: (jwks: PublicRsaJwks) => Promise<T>,
): Promise<T> {
  const keepMs = getEnv().PARTNER_JWKS_CACHE_SECONDS * 1000;
  if (keepMs === 0) return verify(await fetchPartnerJwks(jwksUrl, options));

  const key = keyOf(jwksUrl, options);
  const current = kept.get(key);
  const recent = current && Date.now() - current.fetchedAt < keepMs ? current : undefined;
  if (!recent) kept.delete(key);

  const jwks = recent?.jwks ?? (await fetchAndKeep(key, jwksUrl, options));
  try {
    return await verify(jwks);
  } catch (error) {
    if (!isKeyMismatch(error)) throw error;
    // A set read within the cooldown is the product's current answer: refuse.
    const latest = kept.get(key);
    if (latest && Date.now() - latest.fetchedAt < PARTNER_JWKS_REFRESH_COOLDOWN_MS) throw error;
    return verify(await fetchAndKeep(key, jwksUrl, options));
  }
}

/** Forget every kept set. Tests use it between cases; nothing in production calls it. */
export function resetPartnerJwksCache(): void {
  kept.clear();
  inFlight.clear();
}
