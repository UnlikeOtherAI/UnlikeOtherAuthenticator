import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../config.service.js';
import { getAdminAuthDomain, getAdminBootstrapEmails, getEnv } from '../../config/env.js';
import { getPrisma } from '../../db/prisma.js';
import { getAppLogger } from '../../utils/app-logger.js';
import { extractEmailDomain } from '../../utils/email-domain.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';
import { buildUserIdentity } from '../user-scope.service.js';
import { ensureDomainRoleForUser } from '../domain-role.service.js';
import { isEmailAdminAllowedForRegistration } from '../login-domain-policy.service.js';
import { isPrincipalBannedForRegistration } from '../ban-policy.service.js';
import { placeUserInConfiguredOrganisation } from '../org-placement.service.js';
import { assertProviderVerifiedEmail, type SocialProfile } from './provider.base.js';

type SocialLoginPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique' | 'create' | 'update'>;
  domainRole: Pick<PrismaClient['domainRole'], 'findFirst'>;
};

type SocialLoginDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: SocialLoginPrisma;
  buildUserIdentity?: typeof buildUserIdentity;
  ensureDomainRoleForUser?: typeof ensureDomainRoleForUser;
  placeUserInConfiguredOrganisation?: typeof placeUserInConfiguredOrganisation;
  isEmailAdminAllowedForRegistration?: typeof isEmailAdminAllowedForRegistration;
  isPrincipalBannedForRegistration?: typeof isPrincipalBannedForRegistration;
};

type SocialLoginResult =
  | { status: 'authenticated'; userId: string; twoFaEnabled: boolean }
  | { status: 'blocked' };

function isAllowedByRegistrationDomainPolicy(params: {
  email: string;
  config: ClientConfig;
  requestAccess?: boolean;
}): boolean {
  if (params.config.allow_registration === false) {
    return false;
  }

  if (params.requestAccess) return true;

  const domains = params.config.allowed_registration_domains;
  if (!domains?.length) return true;

  const emailDomain = extractEmailDomain(params.email);
  if (!emailDomain) return false;

  return domains.includes(emailDomain);
}

/**
 * Brief §18 / §22.5: the first user on the admin domain (ADMIN_AUTH_DOMAIN)
 * becomes its SUPERUSER. The first-party Admin panel is intentionally
 * registration-disabled, so without this exception that bootstrap login is
 * rejected by the registration policy and the panel can never gain its initial
 * superuser (chicken-and-egg). Scoped narrowly: only the admin domain, and only
 * while no SUPERUSER row exists yet. Once one does, the registration policy
 * applies to every subsequent new user as normal. Customer domains are
 * unaffected.
 *
 * ADMIN_BOOTSTRAP_EMAILS is an optional allowlist: when set, only a listed
 * email may claim the initial SUPERUSER; when unset, the first admin-domain
 * login wins (brief 22.5).
 */
async function isAdminSuperuserBootstrap(params: {
  env: ReturnType<typeof getEnv>;
  prisma: SocialLoginPrisma;
  domain: string;
  email: string;
}): Promise<boolean> {
  const domain = normalizeDomain(params.domain);
  if (domain !== getAdminAuthDomain(params.env)) {
    return false;
  }

  const allowlist = getAdminBootstrapEmails(params.env);
  if (allowlist.length > 0 && !allowlist.includes(params.email.trim().toLowerCase())) {
    return false;
  }

  const existingSuperuser = await params.prisma.domainRole.findFirst({
    where: { domain, role: 'SUPERUSER' },
    select: { userId: true },
  });
  return !existingSuperuser;
}

export async function loginWithSocialProfile(
  params: {
    profile: SocialProfile;
    config: ClientConfig;
    requestAccess?: boolean;
    ip?: string | null;
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
    // Admin ban list (domain scope) blocks a banned email/pattern/IP before any user row is
    // created. A ban overrides every allow path, including the admin-superuser bootstrap. An
    // existing banned user is instead caught at finalizeAuthenticatedUser (login enforcement).
    const banned = await (deps?.isPrincipalBannedForRegistration ?? isPrincipalBannedForRegistration)({
      domain: params.config.domain,
      email,
      ip: params.ip ?? null,
    });
    if (banned) {
      return { status: 'blocked' };
    }

    const allowedByPolicy = isAllowedByRegistrationDomainPolicy({
      email,
      config: params.config,
      requestAccess: params.requestAccess,
    });
    // A superuser-managed allowlist on the client domain (exact email or email domain) is an
    // explicit grant that overrides the config registration gate: a listed new user may register
    // even when allow_registration is false. An empty allowlist grants nothing.
    const allowedByAdminAllowlist =
      !allowedByPolicy &&
      (await (deps?.isEmailAdminAllowedForRegistration ?? isEmailAdminAllowedForRegistration)({
        domain: params.config.domain,
        email,
      }));
    if (
      !allowedByPolicy &&
      !allowedByAdminAllowlist &&
      !(await isAdminSuperuserBootstrap({ env, prisma, domain: params.config.domain, email }))
    ) {
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
      getAppLogger().error(
        {
          domain: params.config.domain,
          userId,
          errorName: err instanceof Error ? err.name : 'unknown',
        },
        'failed while attempting social registration placement',
      );
    }
  }

  return { status: 'authenticated', userId, twoFaEnabled };
}
