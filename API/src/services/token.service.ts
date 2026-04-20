import { createHmac, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

import { AUTHORIZATION_CODE_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { ACCESS_TOKEN_AUDIENCE } from '../config/jwt.js';
import { getPrisma } from '../db/prisma.js';
import { ensureDomainRoleForUser } from './domain-role.service.js';
import { exchangeRefreshToken, issueRefreshToken } from './refresh-token.service.js';
import { createClientId } from '../utils/hash.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { tryParseHttpUrl } from '../utils/http-url.js';
import { verifyPkceCodeVerifier } from '../utils/pkce.js';
import { getUserOrgContext, type OrgContext } from './org-context.service.js';
import { ensureUserHasRequiredTeam } from './user-team-requirement.service.js';

type TokenPrisma = PrismaClient;

type TokenDeps = {
  prisma?: TokenPrisma;
  now?: () => Date;
  refreshTokenTtlDays?: number;
  sharedSecret?: string;
};

function generateAuthorizationCode(): string {
  // 32 bytes -> 256 bits of entropy; base64url for safe transport in URLs.
  return randomBytes(32).toString('base64url');
}

function hashAuthorizationCode(code: string, pepper: string): string {
  // Store only a hashed code. The raw code is a bearer secret; treat it like email tokens.
  return createHmac('sha256', pepper).update(code, 'utf8').digest('hex');
}

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

function parseHttpUrl(value: string): URL {
  const u = tryParseHttpUrl(value);
  if (!u) throw new AppError('BAD_REQUEST', 400, 'INVALID_REDIRECT_URL');
  return u;
}

export function selectRedirectUrl(params: {
  // `redirect_urls` from verified config JWT.
  allowedRedirectUrls: string[];
  // Optional client-requested redirect URL; must be allowlisted by config.
  requestedRedirectUrl?: string;
}): string {
  const requested = params.requestedRedirectUrl?.trim();
  if (requested) {
    if (!params.allowedRedirectUrls.includes(requested)) {
      throw new AppError('BAD_REQUEST', 400, 'REDIRECT_URL_NOT_ALLOWED');
    }
    // Validate it's a sane URL (prevents "javascript:" etc even if config is malicious).
    parseHttpUrl(requested);
    return requested;
  }

  const candidate = params.allowedRedirectUrls[0]?.trim() ?? '';
  if (!candidate) {
    throw new AppError('BAD_REQUEST', 400, 'MISSING_REDIRECT_URL');
  }

  // Brief 6.6: validate redirect URLs before redirecting.
  parseHttpUrl(candidate);
  return candidate;
}

export function buildRedirectToUrl(params: { redirectUrl: string; code: string }): string {
  const u = parseHttpUrl(params.redirectUrl);
  u.searchParams.set('code', params.code);
  return u.toString();
}

/**
 * Brief 22.13: after a successful authentication, issue a one-time authorization code
 * that can be exchanged by the client backend for an access token.
 */
export async function issueAuthorizationCode(
  params: {
    userId: string;
    domain: string;
    configUrl: string;
    redirectUrl: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    rememberMe?: boolean;
  },
  deps?: TokenDeps,
): Promise<{ code: string }> {
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as TokenPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;

  // Validate redirectUrl again at the boundary; routes should select it via `selectRedirectUrl`.
  parseHttpUrl(params.redirectUrl);

  // Extremely low probability collision; retry a couple times to be safe.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateAuthorizationCode();
    const codeHash = hashAuthorizationCode(code, sharedSecret);
    const expiresAt = new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS);

    try {
      await prisma.authorizationCode.create({
        data: {
          codeHash,
          userId: params.userId,
          domain: params.domain,
          configUrl: params.configUrl,
          redirectUrl: params.redirectUrl,
          codeChallenge: params.codeChallenge,
          codeChallengeMethod: params.codeChallengeMethod,
          rememberMe: params.rememberMe ?? false,
          expiresAt,
        },
        select: { id: true },
      });

      return { code };
    } catch (err) {
      const codeValue = (err as { code?: unknown } | null)?.code;
      // Prisma unique constraint violation code. Avoid importing Prisma types here.
      if (codeValue === 'P2002') continue;
      throw err;
    }
  }

  throw new AppError('INTERNAL', 500, 'AUTH_CODE_COLLISION');
}

async function consumeAuthorizationCode(params: {
  code: string;
  configUrl: string;
  domain: string;
  redirectUrl: string;
  codeVerifier?: string;
  now: Date;
  sharedSecret: string;
  prisma: TokenPrisma;
}): Promise<{ userId: string; rememberMe: boolean }> {
  const codeHash = hashAuthorizationCode(params.code, params.sharedSecret);
  const row = await params.prisma.authorizationCode.findUnique({
    where: { codeHash },
    select: {
      id: true,
      userId: true,
      domain: true,
      configUrl: true,
      redirectUrl: true,
      codeChallenge: true,
      codeChallengeMethod: true,
      rememberMe: true,
      expiresAt: true,
      usedAt: true,
    },
  });

  // Treat all failures as generic auth failure; never leak "expired" vs "unknown" etc.
  if (!row) throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  if (row.domain !== params.domain) throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  if (row.configUrl !== params.configUrl)
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  if (row.redirectUrl !== params.redirectUrl)
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  if (row.codeChallenge) {
    if (row.codeChallengeMethod !== 'S256')
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
    verifyPkceCodeVerifier({
      codeVerifier: params.codeVerifier,
      codeChallenge: row.codeChallenge,
    });
  }
  if (row.usedAt) throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  if (row.expiresAt.getTime() <= params.now.getTime())
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');

  const updated = await params.prisma.authorizationCode.updateMany({
    where: {
      id: row.id,
      usedAt: null,
      expiresAt: { gt: params.now },
    },
    data: {
      usedAt: params.now,
    },
  });
  if (updated.count !== 1) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  }

  return { userId: row.userId, rememberMe: row.rememberMe };
}

async function signAccessToken(params: {
  userId: string;
  email: string;
  domain: string;
  role: 'superuser' | 'user';
  clientId: string;
  sharedSecret: string;
  ttl: string;
  issuer: string;
  org?: OrgContext | null;
}): Promise<string> {
  const payload = {
    email: params.email,
    domain: params.domain,
    client_id: params.clientId,
    role: params.role,
  } as {
    email: string;
    domain: string;
    client_id: string;
    role: 'superuser' | 'user';
    org?: OrgContext;
  };

  if (params.org) {
    payload.org = params.org;
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
    // Normalize token signing failures into a generic error.
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

type TokenIssuerDeps = TokenDeps & {
  accessTokenTtl?: string;
  authServiceIdentifier?: string;
};

type IssuedTokenPair = {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
};

async function issueTokenPairForUser(
  params: {
    config: ClientConfig;
    configUrl: string;
    refreshToken: string;
    refreshTokenExpiresInSeconds: number;
    userId: string;
  },
  deps?: TokenIssuerDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const issuer =
    deps?.authServiceIdentifier ?? requireEnv('AUTH_SERVICE_IDENTIFIER').AUTH_SERVICE_IDENTIFIER;
  const ttl = deps?.accessTokenTtl ?? env.ACCESS_TOKEN_TTL;
  const prisma = deps?.prisma ?? getPrisma();

  const domainRole = await ensureDomainRoleForUser({
    prisma,
    domain: params.config.domain,
    userId: params.userId,
  });

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  });
  if (!user) throw new AppError('INTERNAL', 500, 'MISSING_USER');

  const role = domainRole.role === 'SUPERUSER' ? 'superuser' : 'user';
  const clientId = createClientId(params.config.domain, sharedSecret);
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
    clientId,
    sharedSecret,
    ttl,
    issuer,
    org,
  });

  return {
    accessToken,
    expiresInSeconds: accessTokenExpiresInSeconds(ttl),
    refreshToken: params.refreshToken,
    refreshTokenExpiresInSeconds: params.refreshTokenExpiresInSeconds,
  };
}

/**
 * Client backend exchanges the authorization code for an access token and refresh token pair.
 */
export async function exchangeAuthorizationCodeForTokens(
  params: {
    code: string;
    config: ClientConfig;
    configUrl: string;
    redirectUrl: string;
    codeVerifier?: string;
  },
  deps?: TokenIssuerDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const prisma = deps?.prisma ?? getPrisma();
  const clientId = createClientId(params.config.domain, sharedSecret);

  const { userId, rememberMe } = await consumeAuthorizationCode({
    code: params.code,
    configUrl: params.configUrl,
    domain: params.config.domain,
    redirectUrl: params.redirectUrl,
    codeVerifier: params.codeVerifier,
    now,
    sharedSecret,
    prisma,
  });

  const refreshTtlSeconds = resolveRefreshTokenTtlSeconds(params.config, rememberMe);
  const issuedRefreshToken = await issueRefreshToken(
    {
      userId,
      domain: params.config.domain,
      clientId,
      configUrl: params.configUrl,
    },
    {
      now: deps?.now,
      prisma,
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
      refreshToken: issuedRefreshToken.refreshToken,
      refreshTokenExpiresInSeconds: issuedRefreshToken.expiresInSeconds,
    },
    { ...deps, accessTokenTtl: accessTtl },
  );
}

export async function exchangeRefreshTokenForTokens(
  params: {
    config: ClientConfig;
    configUrl: string;
    refreshToken: string;
  },
  deps?: TokenIssuerDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const prisma = deps?.prisma ?? getPrisma();
  const clientId = createClientId(params.config.domain, sharedSecret);

  const rotatedRefreshToken = await exchangeRefreshToken(
    {
      refreshToken: params.refreshToken,
      domain: params.config.domain,
      clientId,
      configUrl: params.configUrl,
    },
    {
      now: deps?.now,
      prisma,
      sharedSecret,
    },
  );

  const accessTtl = resolveAccessTokenTtl(params.config, getEnv().ACCESS_TOKEN_TTL);
  return issueTokenPairForUser(
    {
      userId: rotatedRefreshToken.userId,
      config: params.config,
      configUrl: params.configUrl,
      refreshToken: rotatedRefreshToken.refreshToken,
      refreshTokenExpiresInSeconds: rotatedRefreshToken.expiresInSeconds,
    },
    { ...deps, accessTokenTtl: accessTtl },
  );
}
