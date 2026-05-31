import { normalizeDomain } from './domain.js';
import { AppError } from './errors.js';

const MAX_ALLOWED_EMAIL_DOMAINS = 50;
// Conservative hostname shape: labels of alphanumerics/hyphens separated by dots, with a TLD.
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Normalise and validate an allowed-email-domains list (used for login restrictions at the
 * client-domain, organisation, and team levels). Lower-cases, trims, de-duplicates, and rejects
 * anything that is not a plausible bare domain. An empty input means "no restriction".
 */
export function normalizeAllowedEmailDomains(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const normalized = normalizeDomain(raw).replace(/^@/, '');
    if (!normalized) continue;
    if (!DOMAIN_PATTERN.test(normalized)) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_EMAIL_DOMAIN');
    }
    seen.add(normalized);
  }
  if (seen.size > MAX_ALLOWED_EMAIL_DOMAINS) {
    throw new AppError('BAD_REQUEST', 400, 'TOO_MANY_EMAIL_DOMAINS');
  }
  return [...seen];
}
