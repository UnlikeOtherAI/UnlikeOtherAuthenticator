import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

import { ACCESS_TOKEN_AUDIENCE } from '../config/constants.js';
import { getAdminAuthDomain, getAuthServiceIdentifier, getEnv, requireEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { ensureDomainRoleForUser, isPlatformSuperuser } from './domain-role.service.js';
import { exchangeRefreshToken, issueRefreshToken } from './refresh-token.service.js';
import { consumeAuthorizationCode } from './authorization-code.service.js';
import { AppError } from '../utils/errors.js';
import { normalizeDomain } from '../utils/domain.js';
import type { ClientConfig } from './config.service.js';
import { getUserOrgContext, type OrgContext } from './org-context.service.js';
import { ensureUserHasRequiredTeam } from './user-team-requirement.service.js';
import { buildFirstLoginBlock, type FirstLoginBlock } from './first-login.service.js';
import { evaluateSignaturePolicy } from './signature-policy.service.js';
import { lockSignaturePolicyForDecision } from './signature-continuation.service.js';

type TokenPrisma = PrismaClient;

type TokenDeps = {
  prisma?: TokenPrisma;
  // BYPASSRLS admin client used for cross-tenant reads (platform-superuser lookup
  // on ADMIN_AUTH_DOMAIN). Defaults to the tenant prisma when omitted.
  adminPrisma?: TokenPrisma;
  now?: () => Date;
  refreshTokenTtlDays?: number;
  sharedSecret?: string;
  // Deterministic concurrency-test hook. Production callers leave this unset.
  afterActiveWorkspaceLock?: () => Promise<void>;
};

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

type ActiveWorkspace = { orgId: string; teamId: string };

async function signAccessToken(params: {
  userId: string;
  email: string;
  domain: string;
  role: 'superuser' | 'user';
  clientId: string;
  sharedSecret: string;
  ttl: string;
  issuer: string;
  tokenVersion: number;
  org?: OrgContext | null;
  active?: ActiveWorkspace | null;
}): Promise<string> {
  const payload = {
    email: params.email,
    domain: params.domain,
    client_id: params.clientId,
    role: params.role,
    tv: params.tokenVersion,
  } as {
    email: string;
    domain: string;
    client_id: string;
    role: 'superuser' | 'user';
    tv: number;
    org?: OrgContext;
    active?: ActiveWorkspace;
  };

  if (params.org) {
    payload.org = params.org;
  }

  if (params.active) {
    payload.active = params.active;
  }

  try {
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(params.issuer)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setSubject(params.userId)
      .setIssuedAt()
      .setExpirationTime(params.ttl)
      .sign(sharedSecretKey(params.sharedSecret));
  } catch {
    throw new AppError('INTERNAL', 500, 'TOKEN_SIGN_FAILED');
  }
}

function accessTokenExpiresInSeconds(ttl: string): number {
  const minutes = Number(ttl.replace(/m$/, ''));
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new AppError('INTERNAL', 500, 'INVALID_ACCESS_TOKEN_TTL');
  }
  return minutes * 60;
}

function resolveAccessTokenTtl(config: ClientConfig, envTtl: string): string {
  const configMinutes = config.session?.access_token_ttl_minutes;
  if (configMinutes != null) return `${configMinutes}m`;
  return envTtl;
}

function resolveRefreshTokenTtlSeconds(config: ClientConfig, rememberMe: boolean): number {
  const session = config.session;
  if (rememberMe) {
    const days = session?.long_refresh_token_ttl_days ?? 30;
    return days * 24 * 60 * 60;
  }
  const hours = session?.short_refresh_token_ttl_hours ?? 1;
  return hours * 60 * 60;
}

function resolveAccessTokenContext(params: {
  clientId?: string;
  domain: string;
  env: ReturnType<typeof getEnv>;
  sharedSecret: string;
}): { clientId: string; sharedSecret: string } {
  const adminDomain = normalizeDomain(getAdminAuthDomain(params.env));
  if (normalizeDomain(params.domain) !== adminDomain) {
    if (!params.clientId) throw new AppError('INTERNAL', 500, 'CLIENT_ID_REQUIRED');
    return {
      clientId: params.clientId,
      sharedSecret: params.sharedSecret,
    };
  }

  if (!params.env.ADMIN_ACCESS_TOKEN_SECRET) {
    throw new AppError('INTERNAL', 500, 'ADMIN_ACCESS_TOKEN_SECRET_REQUIRED');
  }

  return {
    clientId: `admin:${adminDomain}`,
    sharedSecret: params.env.ADMIN_ACCESS_TOKEN_SECRET,
  };
}

type TokenIssuerDeps = TokenDeps & {
  accessTokenTtl?: string;
  authServiceIdentifier?: string;
};

type IssuedTokenPair = {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  firstLogin?: FirstLoginBlock;
};

async function issueTokenPairForUser(
  params: {
    config: ClientConfig;
    configUrl: string;
    clientId?: string;
    refreshToken: string;
    refreshTokenExpiresInSeconds: number;
    userId: string;
    includeFirstLogin?: boolean;
    active?: ActiveWorkspace | null;
  },
  deps?: TokenIssuerDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const issuer = deps?.authServiceIdentifier ?? getAuthServiceIdentifier(env);
  const ttl = deps?.accessTokenTtl ?? env.ACCESS_TOKEN_TTL;
  const prisma = deps?.prisma ?? getPrisma();

  const domainRole = await ensureDomainRoleForUser({
    prisma,
    domain: params.config.domain,
    userId: params.userId,
  });

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true, tokenVersion: true },
  });
  if (!user) throw new AppError('INTERNAL', 500, 'MISSING_USER');

  const role =
    domainRole.role === 'SUPERUSER' ||
    (await isPlatformSuperuser({ userId: params.userId, prisma: deps?.adminPrisma ?? prisma, env }))
      ? 'superuser'
      : 'user';
  const accessTokenContext = resolveAccessTokenContext({
    domain: params.config.domain,
    env,
    clientId: params.clientId,
    sharedSecret,
  });
  await ensureUserHasRequiredTeam(
    {
      userId: params.userId,
      config: params.config,
    },
    { env, prisma },
  );
  const org = params.config.org_features?.enabled
    ? await getUserOrgContext(
        {
          userId: params.userId,
          domain: params.config.domain,
          config: params.config,
        },
        { env, prisma },
      )
    : null;

  const accessToken = await signAccessToken({
    userId: params.userId,
    email: user.email,
    domain: params.config.domain,
    role,
    clientId: accessTokenContext.clientId,
    sharedSecret: accessTokenContext.sharedSecret,
    ttl,
    issuer,
    tokenVersion: user.tokenVersion,
    org,
    active: params.active,
  });

  const firstLogin = params.includeFirstLogin
    ? (await buildFirstLoginBlock({ userId: params.userId, config: params.config }, { prisma })) ??
      undefined
    : undefined;

  return {
    accessToken,
    expiresInSeconds: accessTokenExpiresInSeconds(ttl),
    refreshToken: params.refreshToken,
    refreshTokenExpiresInSeconds: params.refreshTokenExpiresInSeconds,
    firstLogin,
  };
}

export async function exchangeAuthorizationCodeForTokens(
  params: {
    code: string;
    config: ClientConfig;
    configUrl: string;
    redirectUrl: string;
    codeVerifier?: string;
    clientId?: string;
  },
  deps?: TokenIssuerDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const adminPrisma = deps?.adminPrisma ?? deps?.prisma ?? getAdminPrisma();
  const clientId = params.clientId ?? resolveAccessTokenContext({
    domain: params.config.domain,
    env,
    sharedSecret,
  }).clientId;

  return runInTransaction(adminPrisma, async (tx) => {
    const now = deps?.now ? deps.now() : new Date();
    const { userId, rememberMe, orgId, teamId } = await consumeAuthorizationCode({
      code: params.code,
      configUrl: params.configUrl,
      domain: params.config.domain,
      redirectUrl: params.redirectUrl,
      codeVerifier: params.codeVerifier,
      now,
      sharedSecret,
      prisma: tx,
      afterActiveScopeLock: deps?.afterActiveWorkspaceLock,
    });

    // Both values must be present to carry an explicit or unambiguously auto-selected workspace
    // onto the session (design §7 steps 3-4).
    const active: ActiveWorkspace | null = orgId && teamId ? { orgId, teamId } : null;
    const refreshTtlSeconds = resolveRefreshTokenTtlSeconds(params.config, rememberMe);
    const issuedRefreshToken = await issueRefreshToken(
      {
        userId,
        domain: params.config.domain,
        clientId,
        configUrl: params.configUrl,
        orgId,
        teamId,
      },
      {
        now: deps?.now,
        prisma: tx,
        refreshTokenTtlSeconds: refreshTtlSeconds,
        sharedSecret,
      },
    );

    const accessTtl = resolveAccessTokenTtl(params.config, env.ACCESS_TOKEN_TTL);
    return issueTokenPairForUser(
      {
        userId,
        config: params.config,
        configUrl: params.configUrl,
        clientId,
        refreshToken: issuedRefreshToken.refreshToken,
        refreshTokenExpiresInSeconds: issuedRefreshToken.expiresInSeconds,
        includeFirstLogin: true,
        active,
      },
      {
        ...deps,
        prisma: tx,
        adminPrisma: tx,
        accessTokenTtl: accessTtl,
      },
    );
  });
}

export async function exchangeRefreshTokenForTokens(
  params: {
    config: ClientConfig;
    configUrl: string;
    refreshToken: string;
    clientId?: string;
  },
  deps?: TokenIssuerDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const prisma = deps?.prisma ?? getPrisma();
  const adminPrisma = deps?.adminPrisma ?? prisma;
  const clientId = params.clientId ?? resolveAccessTokenContext({
    domain: params.config.domain,
    env,
    sharedSecret,
  }).clientId;

  const exchangeInsideTransaction = async (tx: PrismaClient): Promise<IssuedTokenPair> => {
    const rotatedRefreshToken = await exchangeRefreshToken(
      {
        refreshToken: params.refreshToken,
        domain: params.config.domain,
        clientId,
        configUrl: params.configUrl,
      },
      {
        now: deps?.now,
        prisma: tx,
        sharedSecret,
        beforeRotate: async ({ userId, domain }) => {
          await lockSignaturePolicyForDecision(tx, domain);
          const policy = await evaluateSignaturePolicy(
            { domain, userId, now: deps?.now?.() },
            { prisma: tx },
          );
          if (!policy.complete) {
            // Keep this indistinguishable from the normal invalid-grant response.
            // The client must restart interactive authorization, where signing is available.
            throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
          }
        },
      },
    );

    // Re-validate the session's workspace scope on every refresh (design §7 step 4): a deactivated
    // or removed membership must not linger in `active` past the current access-token TTL. Dormant
    // today since nothing populates refresh_tokens.org_id/team_id yet.
    let active: ActiveWorkspace | null = null;
    if (rotatedRefreshToken.orgId && rotatedRefreshToken.teamId) {
      const orgContext = params.config.org_features?.enabled
        ? await getUserOrgContext(
            {
              userId: rotatedRefreshToken.userId,
              domain: params.config.domain,
              config: params.config,
            },
            { env, prisma: tx },
          )
        : null;
      if (orgContext?.teams.includes(rotatedRefreshToken.teamId)) {
        active = { orgId: rotatedRefreshToken.orgId, teamId: rotatedRefreshToken.teamId };
      }
    }

    const accessTtl = resolveAccessTokenTtl(params.config, getEnv().ACCESS_TOKEN_TTL);
    return issueTokenPairForUser(
      {
        userId: rotatedRefreshToken.userId,
        config: params.config,
        configUrl: params.configUrl,
        clientId,
        refreshToken: rotatedRefreshToken.refreshToken,
        refreshTokenExpiresInSeconds: rotatedRefreshToken.expiresInSeconds,
        active,
      },
      {
        ...deps,
        prisma: tx,
        adminPrisma: tx,
        accessTokenTtl: accessTtl,
      },
    );
  };

  // Production passes the BYPASSRLS client here. Keeping the complete refresh decision in
  // one transaction makes policy publication/revocation checks atomic with token rotation.
  if (typeof adminPrisma.$transaction === 'function') {
    return adminPrisma.$transaction(async (tx) =>
      exchangeInsideTransaction(tx as unknown as PrismaClient),
    );
  }
  return exchangeInsideTransaction(adminPrisma);
}
