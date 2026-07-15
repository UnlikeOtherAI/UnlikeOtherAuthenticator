// Public-client token exchange for the MCP profile (brief §22.14): redeem an
// authorization code (PKCE, no client secret) for a resource-bound RS256 access
// token. Refresh-token issuance for this profile is a follow-up.
import type { Prisma, PrismaClient } from '@prisma/client';

import { getEnv, getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { ensureDomainRoleForUser, isPlatformSuperuser } from '../domain-role.service.js';
import { signMcpAccessToken } from './access-token.service.js';
import { consumeOAuthCode } from './oauth-code.service.js';

type Db = Prisma.TransactionClient;

function accessTokenTtlSeconds(): number {
  // ACCESS_TOKEN_TTL is validated minutes-only (e.g. "30m"); see config/env.ts.
  const minutes = Number(getEnv().ACCESS_TOKEN_TTL.replace(/m$/, ''));
  return minutes * 60;
}

export interface OAuthTokenResult {
  accessToken: string;
  expiresInSeconds: number;
}

export async function exchangeOAuthCodeForAccessToken(
  params: {
    code: string;
    clientId: string;
    redirectUrl: string;
    codeVerifier?: string;
    domain: string;
    scope?: string;
  },
  prisma: Db,
  // BYPASSRLS admin client for the cross-tenant platform-superuser lookup on
  // ADMIN_AUTH_DOMAIN. Defaults to the tenant tx when omitted.
  adminPrisma?: PrismaClient,
): Promise<OAuthTokenResult> {
  const consumed = await consumeOAuthCode(
    {
      code: params.code,
      oauthClientId: params.clientId,
      redirectUrl: params.redirectUrl,
      codeVerifier: params.codeVerifier,
    },
    prisma,
  );
  if (params.scope !== undefined && params.scope !== consumed.scope) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  }

  const domainRole = await ensureDomainRoleForUser({
    prisma: prisma as unknown as Parameters<typeof ensureDomainRoleForUser>[0]['prisma'],
    domain: params.domain,
    userId: consumed.userId,
  });

  const user = await prisma.user.findUnique({
    where: { id: consumed.userId },
    select: { email: true },
  });
  if (!user) throw new AppError('INTERNAL', 500, 'MISSING_USER');

  const platformSuperuser = await isPlatformSuperuser({
    userId: consumed.userId,
    prisma: (adminPrisma ?? prisma) as Parameters<typeof isPlatformSuperuser>[0]['prisma'],
  });

  const issuer = getPublicBaseUrl();
  const ttlSeconds = accessTokenTtlSeconds();
  const accessToken = await signMcpAccessToken({
    subject: consumed.userId,
    email: user.email,
    domain: params.domain,
    clientId: params.clientId,
    role: domainRole.role === 'SUPERUSER' || platformSuperuser ? 'superuser' : 'user',
    // RFC 8707: bind the token to the requested resource; fall back to the issuer.
    resource: consumed.resource ?? issuer,
    issuer,
    ttlSeconds,
    scope: consumed.scope ?? undefined,
  });

  return { accessToken, expiresInSeconds: ttlSeconds };
}
