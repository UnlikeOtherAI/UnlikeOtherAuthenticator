import { AppError } from '../utils/errors.js';

export type UserScope = 'global' | 'per_domain';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Builds the stable user identity fields used by the database.
 *
 * Brief 22.12:
 * - global: one user per email across all domains
 * - per_domain: same email on different domains => separate user records
 *
 * We implement this by enforcing uniqueness on `user_key` rather than `email`.
 */
export function buildUserIdentity(params: {
  userScope: UserScope;
  email: string;
  domain?: string;
}): { email: string; domain: string | null; userKey: string } {
  const email = normalizeEmail(params.email);
  if (!email) throw new AppError('BAD_REQUEST', 400);

  if (params.userScope === 'global') {
    return { email, domain: null, userKey: email };
  }

  const domain = normalizeDomain(params.domain ?? '');
  if (!domain) throw new AppError('BAD_REQUEST', 400);

  // Separator chosen to be stable and unambiguous for lookups.
  return { email, domain, userKey: `${domain}|${email}` };
}

