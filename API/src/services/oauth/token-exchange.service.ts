import { authorizeCredentialSurface } from '../credential-route-registry.service.js';
import { publicCredentialTtl } from './credential-source.service.js';
import { requireIdentityEmail } from '../entity-lifecycle.service.js';
// Public-client token exchange for the MCP profile (brief §22.14): redeem an
// authorization code (PKCE, no client secret) for a resource-bound RS256 access
// token. Registered native-app clients additionally start a rotating refresh-token
// family in the same transaction (see native-refresh.service.ts); plain dynamic
// registrations receive only the access token.
import type { Prisma, PrismaClient } from '@prisma/client';

import { getEnv, getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { ensureDomainRoleForUser, isPlatformSuperuser } from '../domain-role.service.js';
import { buildMcpClientConfig } from './config.service.js';
import { validatePublicScopes } from './scopes.service.js';
import { getOAuthClient } from './client.service.js';
import { lockProductTeamPolicyShared } from '../product-team-policy-lock.service.js';
import { resolveTwoFaPolicy, isTwoFaAuthenticationSufficient } from '../twofactor-policy.service.js';
import { signMcpAccessToken } from './access-token.service.js';
import { consumeOAuthCode } from './oauth-code.service.js';
import { isNativeRefreshClient, issueNativeRefreshToken } from './native-refresh.service.js';

type Db = Prisma.TransactionClient;

function accessTokenTtlSeconds(): number {
  // ACCESS_TOKEN_TTL is validated minutes-only (e.g. "30m"); see config/env.ts.
  const minutes = Number(getEnv().ACCESS_TOKEN_TTL.replace(/m$/, ''));
  return minutes * 60;
}

export interface OAuthTokenResult {
  accessToken: string;
  expiresInSeconds: number;
  /** Present only for registered native-app clients. */
  refreshToken?: string;
  refreshTokenExpiresInSeconds?: number;
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
  _adminPrisma?: PrismaClient,
): Promise<OAuthTokenResult> {
  await lockProductTeamPolicyShared(prisma);
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

  if (consumed.domain !== params.domain) throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  const client = await getOAuthClient(params.clientId, prisma);
  if (!client) throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  validatePublicScopes(consumed.scope ?? undefined, client.scopes);
  const config = buildMcpClientConfig(client.redirectUris, client.nativeApp);
  const current = await prisma.user.findUnique({ where: { lifecycleStatus: 'ACTIVE', id: consumed.userId }, select: { twoFaEnabled: true } });
  const policy = await resolveTwoFaPolicy({ config, userId: consumed.userId }, { prisma });
  if (!current || !isTwoFaAuthenticationSufficient({ policy, twoFaEnabled: current.twoFaEnabled, twoFaCompleted: consumed.twoFaCompleted })) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
  const domainRole = await ensureDomainRoleForUser({
    prisma: prisma as unknown as Parameters<typeof ensureDomainRoleForUser>[0]['prisma'],
    domain: params.domain,
    userId: consumed.userId,
  });

  const user = await prisma.user.findUnique({
    where: { lifecycleStatus: 'ACTIVE', id: consumed.userId },
    select: { email: true },
  });
  if (!user) throw new AppError('INTERNAL', 500, 'MISSING_USER');

  const platformSuperuser = await isPlatformSuperuser({
    userId: consumed.userId,
    prisma: prisma as Parameters<typeof isPlatformSuperuser>[0]['prisma'],
  });

  const evidence = await authorizeCredentialSurface('public_authorization', { userId: consumed.userId,
    clientDomain: params.domain, credentialEpoch: consumed.credentialEpoch,
    authenticationEvidenceId: consumed.authenticationEvidenceId }, prisma);
  const refresh = isNativeRefreshClient(client) ? await issueNativeRefreshToken({ userId: consumed.userId,
    clientId: params.clientId, domain: params.domain, credentialEpoch: consumed.credentialEpoch,
    authenticationEvidenceId: consumed.authenticationEvidenceId, twoFaCompleted: consumed.twoFaCompleted,
    scope: consumed.scope, resource: consumed.resource }, prisma) : undefined;
  if (!refresh && consumed.authenticationEvidenceId) {
    const used = await prisma.authenticationEvidence.updateMany({ where: { id: consumed.authenticationEvidenceId,
      consumedAt: null, revokedAt: null }, data: { consumedAt: new Date() } });
    if (used.count !== 1) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_EVIDENCE_REQUIRED');
  }
  const issuer = getPublicBaseUrl();
  const ttlSeconds = publicCredentialTtl(accessTokenTtlSeconds(), refresh?.assuranceExpiresAt
    ? new Date(refresh.assuranceExpiresAt) : evidence?.expiresAt);
  const accessToken = await signMcpAccessToken({
    subject: consumed.userId,
    assuranceId: refresh?.assuranceId,
    authenticationEvidenceId: refresh?.assuranceId ? undefined : consumed.authenticationEvidenceId,
    credentialEpoch: consumed.credentialEpoch,
    twoFaCompleted: consumed.twoFaCompleted,
    email: requireIdentityEmail(user.email),
    domain: params.domain,
    clientId: params.clientId,
    role: !client.nativeAppId && (domainRole.role === 'SUPERUSER' || platformSuperuser) ? 'superuser' : 'user',
    // RFC 8707: bind the token to the requested resource; fall back to the issuer.
    resource: consumed.resource ?? issuer,
    issuer,
    ttlSeconds,
    scope: consumed.scope ?? undefined,
  });

  if (!refresh) return { accessToken, expiresInSeconds: ttlSeconds };
  return {
    accessToken,
    expiresInSeconds: ttlSeconds,
    refreshToken: refresh.refreshToken,
    refreshTokenExpiresInSeconds: refresh.expiresInSeconds,
  };
}
