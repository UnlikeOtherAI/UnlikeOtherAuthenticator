// Rotating refresh tokens for registered native-app clients of the public OAuth profile
// (brief §22.14, Docs/Auth/native-accounts.md). This reuses the confidential refresh-token
// machinery unchanged — families, rotation with inherited TTL, the 120 s response-loss replay
// grace, reuse detection with family + credential-epoch revocation — bound to a public context
// that can never match a confidential /auth/token row. Plain dynamic (MCP) registrations never
// receive a refresh token.
import type { Prisma, PrismaClient } from '@prisma/client';

import { getEnv, getPublicBaseUrl } from '../../config/env.js';
import { AppError, isAppError } from '../../utils/errors.js';
import { lockProductTeamPolicyShared } from '../product-team-policy-lock.service.js';
import type { RefreshTokenContext } from '../refresh-token-replay.service.js';
import {
  createRefreshTokenFamilyDecisionLock,
  createRefreshTokenRotationPolicyGuard,
} from '../refresh-token-rotation-policy.service.js';
import {
  exchangeRefreshToken,
  issueRefreshToken,
  revokeRefreshTokenFamily,
} from '../refresh-token.service.js';
import { runRefreshTokenExchangeTransaction } from '../refresh-token-transaction.service.js';
import { accessTokenExpiresInSeconds } from '../token-session-ttl.service.js';
import {
  isTwoFaAuthenticationSufficient,
  resolveTwoFaPolicy,
} from '../twofactor-policy.service.js';
import { signMcpAccessToken } from './access-token.service.js';
import { getOAuthClient } from './client.service.js';
import { buildMcpClientConfig, resolveMcpOAuthDomain } from './config.service.js';
import { validateRequestedResource } from './resource-validation.service.js';
import { validatePublicScopes } from './scopes.service.js';

/**
 * Stored in the non-null `config_url` column of every public family. A URN is never an
 * acceptable signed-config URL, and public client ids never equal a domain hash, so neither
 * grant can present — or revoke — the other's rows.
 */
export const PUBLIC_OAUTH_REFRESH_CONFIG_URL = 'urn:unlikeotherai:uoa:public-oauth-client';

export function publicRefreshContext(clientId: string, domain: string): RefreshTokenContext {
  return { clientId, domain, configUrl: PUBLIC_OAUTH_REFRESH_CONFIG_URL };
}

/** Only clients registered against an enabled, current native-app policy may hold a refresh
 *  token. `getOAuthClient` already drops disabled or stale-revision app registrations. */
export function isNativeRefreshClient(client: { nativeAppId: string | null } | null): boolean {
  return Boolean(client?.nativeAppId);
}

function rejectRefresh(): never {
  throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
}

/** Start a new family for a just-redeemed native authorization code, in the caller's code
 *  exchange transaction (which already holds the credential-epoch locks). */
export async function issueNativeRefreshToken(
  params: {
    userId: string;
    clientId: string;
    domain: string;
    credentialEpoch: number;
    twoFaCompleted: boolean;
    scope: string | null;
    resource: string | null;
  },
  prisma: Prisma.TransactionClient,
): Promise<{ refreshToken: string; expiresInSeconds: number }> {
  const issued = await issueRefreshToken(
    {
      userId: params.userId,
      ...publicRefreshContext(params.clientId, params.domain),
      twoFaCompleted: params.twoFaCompleted,
      credentialEpoch: params.credentialEpoch,
      oauthScope: params.scope,
      resource: params.resource,
    },
    { prisma: prisma as unknown as PrismaClient },
  );
  return { refreshToken: issued.refreshToken, expiresInSeconds: issued.expiresInSeconds };
}

export interface NativeRefreshResult {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  scope: string | null;
}

async function rotateNativeRefreshToken(
  params: { refreshToken: string; clientId: string; scope?: string },
  tx: PrismaClient,
): Promise<NativeRefreshResult> {
  // Native-app policy writers take this lock exclusively: a disable or security edit either
  // commits first (and the client lookup below rejects) or waits for this rotation to commit.
  await lockProductTeamPolicyShared(tx);
  const client = await getOAuthClient(params.clientId, tx);
  if (!client || !isNativeRefreshClient(client)) rejectRefresh();
  const config = buildMcpClientConfig(client.redirectUris, client.nativeApp);

  const rotated = await exchangeRefreshToken(
    { refreshToken: params.refreshToken, ...publicRefreshContext(client.clientId, config.domain) },
    {
      prisma: tx,
      beforeFamilyDecision: createRefreshTokenFamilyDecisionLock({ prisma: tx }),
      beforeRotate: createRefreshTokenRotationPolicyGuard({ prisma: tx }),
    },
  );

  // The family decision holds the user-global lock that every credential writer takes, so this
  // read is linearized with password reset, 2FA changes, logout and reuse revocation. Any epoch
  // increment since the originating login ends the family. Throwing rolls the rotation back.
  const user = await tx.user.findUnique({
    where: { id: rotated.userId },
    select: { email: true, tokenVersion: true, twoFaEnabled: true },
  });
  const credentialEpoch = rotated.credentialEpoch;
  if (!user || credentialEpoch === null || user.tokenVersion !== credentialEpoch) rejectRefresh();
  const policy = await resolveTwoFaPolicy({ config, userId: rotated.userId }, { prisma: tx });
  if (
    !isTwoFaAuthenticationSufficient({
      policy,
      twoFaEnabled: user.twoFaEnabled,
      twoFaCompleted: rotated.twoFaCompleted,
    })
  ) {
    rejectRefresh();
  }
  // Never broader than the original grant: an explicit scope must repeat it exactly, and the
  // stored grant must still fit the client registration, the server allowlist and the resource
  // allowlist.
  if (params.scope !== undefined && params.scope !== rotated.oauthScope) rejectRefresh();
  validatePublicScopes(rotated.oauthScope ?? undefined, client.scopes);
  if (rotated.resource !== null) validateRequestedResource(rotated.resource);

  const issuer = getPublicBaseUrl();
  const ttlSeconds = accessTokenExpiresInSeconds(getEnv().ACCESS_TOKEN_TTL);
  const accessToken = await signMcpAccessToken({
    subject: rotated.userId,
    credentialEpoch,
    twoFaCompleted: rotated.twoFaCompleted,
    email: user.email,
    domain: config.domain,
    clientId: client.clientId,
    // Native registrations never confer an administrative role (same as the code exchange).
    role: 'user',
    resource: rotated.resource ?? issuer,
    issuer,
    ttlSeconds,
    scope: rotated.oauthScope ?? undefined,
  });

  return {
    accessToken,
    expiresInSeconds: ttlSeconds,
    refreshToken: rotated.refreshToken,
    refreshTokenExpiresInSeconds: rotated.expiresInSeconds,
    scope: rotated.oauthScope,
  };
}

/**
 * `grant_type=refresh_token` for a public native-app client. Every refusal — unknown, expired,
 * revoked, reused or foreign-client token, disabled app, missing user, changed credentials,
 * insufficient second factor, incomplete signature policy or a narrowed allowlist — is the same
 * opaque 401 INVALID_REFRESH_TOKEN. Reuse detection still commits its family + epoch revocation
 * before that answer is sent.
 */
export async function exchangeNativeRefreshToken(
  params: { refreshToken: string; clientId: string; scope?: string },
  adminPrisma: PrismaClient,
): Promise<NativeRefreshResult> {
  try {
    return await runRefreshTokenExchangeTransaction(adminPrisma, (tx) =>
      rotateNativeRefreshToken(params, tx),
    );
  } catch (error) {
    if (isAppError(error) && error.statusCode >= 400 && error.statusCode < 500) rejectRefresh();
    throw error;
  }
}

/**
 * RFC 7009 revocation for a public client. Revokes the presented token's family — using the
 * same logout semantics as confidential `/auth/revoke` (family revocation plus one credential
 * epoch increment) — only when the token belongs to this exact client. Unknown, foreign or
 * repeated tokens are a silent no-op so the answer is never an oracle.
 */
export async function revokeNativeRefreshToken(
  params: { token: string; clientId: string },
  adminPrisma: PrismaClient,
): Promise<void> {
  await revokeRefreshTokenFamily(
    {
      refreshToken: params.token,
      ...publicRefreshContext(params.clientId, resolveMcpOAuthDomain()),
    },
    { prisma: adminPrisma },
  );
}
