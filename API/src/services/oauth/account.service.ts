import { createLocalJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
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

const PublicAccountClaims = z.object({
  token_use: z.literal('public_oauth'), sub: z.string().min(1),
  client_id: z.string().min(1), domain: z.string().min(1),
  tv: z.number().int().nonnegative(), exp: z.number(), scope: z.string(),
  twofa: z.boolean().optional(),
});

export async function verifyPublicAccountToken(authorization: string | undefined, scope: string) {
  let claims: z.infer<typeof PublicAccountClaims>;
  try {
    if (!authorization?.startsWith('Bearer ')) throw new Error('missing');
    const { payload } = await jwtVerify(authorization.slice(7), createLocalJWKSet(await getAccessTokenPublicJwks()), {
      algorithms: ['RS256'], typ: 'at+jwt', issuer: getPublicBaseUrl(), audience: getPublicBaseUrl(),
      requiredClaims: ['sub', 'exp', 'iat', 'tv', 'client_id', 'domain', 'token_use'],
    });
    claims = PublicAccountClaims.parse(payload);
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
  // Database/configuration outages are not invalid credentials. Keep these outside
  // the untrusted-token catch so clients retain their healthy session and retry.
  const client = await getOAuthClient(claims.client_id);
  if (!client) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  const config = buildMcpClientConfig(client.redirectUris, client.nativeApp);
  if (claims.domain !== config.domain) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  validatePublicScopes(claims.scope, client.scopes);
  if (!claims.scope.split(' ').includes(scope)) throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_SCOPE');
  return { userId: claims.sub, domain: config.domain, credentialEpoch: claims.tv,
    expiresAt: claims.exp, twoFaCompleted: claims.twofa === true, config, clientId: claims.client_id };
}

export async function authorizePublicAccount(
  account: Awaited<ReturnType<typeof verifyPublicAccountToken>>, prisma: Prisma.TransactionClient,
): Promise<void> {
  await lockProductTeamPolicyShared(prisma);
  if (!await getOAuthClient(account.clientId, prisma)) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  await lockAndAssertAuthenticationEpoch(account, { prisma });
  if (account.expiresAt <= Date.now() / 1000) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  const user = await prisma.user.findUnique({ where: { lifecycleStatus: 'ACTIVE', id: account.userId }, select: { twoFaEnabled: true } });
  const policy = await resolveTwoFaPolicy({ config: account.config, userId: account.userId }, { prisma });
  if (!user || !isTwoFaAuthenticationSufficient({ policy, twoFaEnabled: user.twoFaEnabled, twoFaCompleted: account.twoFaCompleted })) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
}
