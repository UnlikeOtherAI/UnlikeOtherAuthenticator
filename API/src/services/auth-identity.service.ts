import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { getEnv } from '../config/env.js';

/**
 * Auth identities (design §4.2). Records which providers a person has authenticated with, giving the
 * token `method` claim a persistence home and turning merge-by-verified-email into an auditable
 * record. Admin-managed: written via the BYPASSRLS admin client because authentication runs before a
 * stable tenant context exists, and the table is locked down for uoa_app.
 */

export type AuthIdentityProvider =
  | 'email'
  | 'google'
  | 'github'
  | 'microsoft'
  | 'apple'
  | 'facebook'
  | 'linkedin';

const SOCIAL_PROVIDERS = new Set<AuthIdentityProvider>([
  'google',
  'github',
  'microsoft',
  'apple',
  'facebook',
  'linkedin',
]);

/**
 * Map the login-log `authMethod` string to a canonical identity provider. Social callbacks pass the
 * provider name directly; every email-based method (email/password, magic link, verification link)
 * collapses to `email`.
 */
export function mapAuthMethodToProvider(authMethod: string): AuthIdentityProvider {
  const method = authMethod.trim().toLowerCase();
  if (SOCIAL_PROVIDERS.has(method as AuthIdentityProvider)) {
    return method as AuthIdentityProvider;
  }
  return 'email';
}

export type AuthIdentityPrisma = Pick<PrismaClient, 'authIdentity'>;

type AuthIdentityDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: AuthIdentityPrisma;
  now?: () => Date;
};

/**
 * Upsert the auth identity for a successful login, keyed by (userId, provider). Idempotent: a repeat
 * login refreshes `lastLoginAt` (and `providerSubject`, which social phases can refine to the real
 * OAuth subject). No-op when the database is disabled. Best-effort — callers should not fail a login
 * if this write fails.
 */
export async function recordAuthIdentity(
  params: {
    userId: string;
    provider: AuthIdentityProvider;
    providerSubject: string;
    email: string;
    providerTenant?: string | null;
  },
  deps?: AuthIdentityDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return;

  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as AuthIdentityPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const email = params.email.trim().toLowerCase();
  const providerSubject = params.providerSubject.trim() || email;

  await prisma.authIdentity.upsert({
    where: { userId_provider: { userId: params.userId, provider: params.provider } },
    create: {
      userId: params.userId,
      provider: params.provider,
      providerSubject,
      email,
      providerTenant: params.providerTenant ?? null,
      verifiedAt: now,
      lastLoginAt: now,
    },
    update: {
      providerSubject,
      email,
      ...(params.providerTenant !== undefined ? { providerTenant: params.providerTenant } : {}),
      lastLoginAt: now,
    },
  });
}
