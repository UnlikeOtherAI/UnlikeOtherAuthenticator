import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../config.service.js';
import { getEnv } from '../../config/env.js';
import { getPrisma } from '../../db/prisma.js';
import { AppError } from '../../utils/errors.js';
import { buildUserIdentity } from '../user-scope.service.js';
import { ensureDomainRoleForUser } from '../domain-role.service.js';
import { placeUserInConfiguredOrganisation } from '../org-placement.service.js';
import { assertProviderVerifiedEmail, type SocialProfile } from './provider.base.js';

type SocialLoginPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique' | 'create' | 'update'>;
};

type SocialLoginDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: SocialLoginPrisma;
  buildUserIdentity?: typeof buildUserIdentity;
  ensureDomainRoleForUser?: typeof ensureDomainRoleForUser;
  placeUserInConfiguredOrganisation?: typeof placeUserInConfiguredOrganisation;
};

type SocialLoginResult =
  | { status: 'authenticated'; userId: string; twoFaEnabled: boolean }
  | { status: 'blocked' };

function extractEmailDomain(email: string): string | null {
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0 || atIndex === email.length - 1) return null;
  return email.slice(atIndex + 1).toLowerCase();
}

function isAllowedByRegistrationDomainPolicy(params: {
  email: string;
  config: ClientConfig;
}): boolean {
  const domains = params.config.allowed_registration_domains;
  if (!domains?.length) return true;

  const emailDomain = extractEmailDomain(params.email);
  if (!emailDomain) return false;

  return domains.includes(emailDomain);
}

export async function loginWithSocialProfile(
  params: {
    profile: SocialProfile;
    config: ClientConfig;
  },
  deps?: SocialLoginDeps,
): Promise<SocialLoginResult> {
  assertProviderVerifiedEmail(params.profile);

  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const identityBuilder = deps?.buildUserIdentity ?? buildUserIdentity;
  const { userKey, domain, email } = identityBuilder({
    userScope: params.config.user_scope,
    email: params.profile.email,
    domain: params.config.domain,
  });

  const prisma = deps?.prisma ?? (getPrisma() as unknown as SocialLoginPrisma);

  const existing = await prisma.user.findUnique({
    where: { userKey },
    select: { id: true },
  });

  let userId: string;
  let twoFaEnabled: boolean;
  let createdUser = false;
  if (existing) {
    const updated = await prisma.user.update({
      where: { userKey },
      data: {
        // Keep identity stable and normalized.
        email,
        domain,
        name: params.profile.name,
        // Brief 22.7: overwrite avatar URL on every login.
        avatarUrl: params.profile.avatarUrl,
      },
      select: { id: true, twoFaEnabled: true },
    });
    userId = updated.id;
    twoFaEnabled = updated.twoFaEnabled;
  } else {
    if (!isAllowedByRegistrationDomainPolicy({ email, config: params.config })) {
      return { status: 'blocked' };
    }

    const created = await prisma.user.create({
      data: {
        email,
        userKey,
        domain,
        name: params.profile.name,
        avatarUrl: params.profile.avatarUrl,
        passwordHash: null,
      },
      select: { id: true, twoFaEnabled: true },
    });
    userId = created.id;
    twoFaEnabled = created.twoFaEnabled;
    createdUser = true;
  }

  // Ensure domain-level role exists for this login domain (superuser assignment is per-domain).
  await (deps?.ensureDomainRoleForUser ?? ensureDomainRoleForUser)({
    domain: params.config.domain,
    userId,
    prisma: prisma as unknown as PrismaClient,
  });

  if (createdUser) {
    try {
      await (deps?.placeUserInConfiguredOrganisation ?? placeUserInConfiguredOrganisation)({
        userId,
        email,
        config: params.config,
      });
    } catch (err) {
      console.error('[org-placement]', 'failed while attempting social registration placement', {
        domain: params.config.domain,
        userId,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  return { status: 'authenticated', userId, twoFaEnabled };
}
