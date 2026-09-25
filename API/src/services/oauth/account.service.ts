import { createLocalJWKSet, jwtVerify } from 'jose';
import type { Prisma } from '@prisma/client';
import { getPublicBaseUrl } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { getAccessTokenPublicJwks } from './access-token.service.js';
import { getOAuthClient } from './client.service.js';
import { buildMcpClientConfig } from './config.service.js';
import { validatePublicScopes } from './scopes.service.js';
import { lockAndAssertAuthenticationEpoch } from '../authentication-epoch.service.js';
import { lockProductTeamPolicyShared } from '../product-team-policy-lock.service.js';
import { resolveTwoFaPolicy, isTwoFaAuthenticationSufficient } from '../twofactor-policy.service.js';

export async function verifyPublicAccountToken(authorization: string | undefined, scope: string) {
  try {
    if (!authorization?.startsWith('Bearer ')) throw new Error('missing');
    const { payload } = await jwtVerify(authorization.slice(7), createLocalJWKSet(await getAccessTokenPublicJwks()), {
      algorithms: ['RS256'], typ: 'at+jwt', issuer: getPublicBaseUrl(), audience: getPublicBaseUrl(),
      requiredClaims: ['sub', 'exp', 'iat', 'tv', 'client_id', 'domain', 'token_use'],
    });
    if (payload.token_use !== 'public_oauth' || typeof payload.sub !== 'string' ||
        typeof payload.client_id !== 'string' || typeof payload.domain !== 'string' ||
        typeof payload.tv !== 'number' || !Number.isSafeInteger(payload.tv) || payload.tv < 0 ||
        typeof payload.exp !== 'number' || typeof payload.scope !== 'string') throw new Error('claims');
    const client = await getOAuthClient(payload.client_id);
    if (!client) throw new Error('client');
    const config = buildMcpClientConfig(client.redirectUris, client.nativeApp);
    if (payload.domain !== config.domain) throw new Error('domain');
    validatePublicScopes(payload.scope, client.scopes);
    if (!payload.scope.split(' ').includes(scope)) throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_SCOPE');
    return { userId: payload.sub, domain: config.domain, credentialEpoch: payload.tv,
      expiresAt: payload.exp, twoFaCompleted: payload.twofa === true, config, clientId: payload.client_id };
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 403) throw error;
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
}

export async function authorizePublicAccount(
  account: Awaited<ReturnType<typeof verifyPublicAccountToken>>, prisma: Prisma.TransactionClient,
): Promise<void> {
  await lockProductTeamPolicyShared(prisma);
  if (!await getOAuthClient(account.clientId, prisma)) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  await lockAndAssertAuthenticationEpoch(account, { prisma });
  if (account.expiresAt <= Date.now() / 1000) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  const user = await prisma.user.findUnique({ where: { id: account.userId }, select: { twoFaEnabled: true } });
  const policy = await resolveTwoFaPolicy({ config: account.config, userId: account.userId }, { prisma });
  if (!user || !isTwoFaAuthenticationSufficient({ policy, twoFaEnabled: user.twoFaEnabled, twoFaCompleted: account.twoFaCompleted })) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
}
