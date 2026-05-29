// Authorization-code issue/consume for the public-client / MCP profile (brief
// §22.14). Distinct from token.service's config-JWT path: these codes are keyed on
// the registered oauth_client_id (+ resource), carry config_url = null, and are
// redeemed at the public, secret-less /oauth/token endpoint. PKCE S256 is mandatory.
import { createHmac, randomBytes } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { AUTHORIZATION_CODE_TTL_MS } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { verifyPkceCodeVerifier } from '../../utils/pkce.js';

type Db = Prisma.TransactionClient;

function generateCode(): string {
  return randomBytes(32).toString('base64url');
}

// Same HMAC scheme as token.service.hashAuthorizationCode so codes are never stored
// in the clear and the two profiles share one hashing convention.
function hashCode(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code, 'utf8').digest('hex');
}

export interface IssueOAuthCodeInput {
  userId: string;
  domain: string;
  oauthClientId: string;
  redirectUrl: string;
  resource?: string;
  state?: string;
  codeChallenge: string;
  rememberMe?: boolean;
}

export async function issueOAuthCode(
  input: IssueOAuthCodeInput,
  prisma: Db,
  now: Date = new Date(),
): Promise<{ code: string }> {
  const sharedSecret = requireEnv('SHARED_SECRET').SHARED_SECRET;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      await prisma.authorizationCode.create({
        data: {
          codeHash: hashCode(code, sharedSecret),
          userId: input.userId,
          domain: input.domain,
          configUrl: null,
          redirectUrl: input.redirectUrl,
          oauthClientId: input.oauthClientId,
          resource: input.resource ?? null,
          state: input.state ?? null,
          codeChallenge: input.codeChallenge,
          codeChallengeMethod: 'S256',
          rememberMe: input.rememberMe ?? false,
          expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
        },
        select: { id: true },
      });
      return { code };
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'P2002') continue;
      throw err;
    }
  }
  throw new AppError('INTERNAL', 500, 'AUTH_CODE_COLLISION');
}

export interface ConsumeOAuthCodeResult {
  userId: string;
  resource: string | null;
  rememberMe: boolean;
}

export async function consumeOAuthCode(
  params: { code: string; oauthClientId: string; redirectUrl: string; codeVerifier?: string },
  prisma: Db,
  now: Date = new Date(),
): Promise<ConsumeOAuthCodeResult> {
  const sharedSecret = requireEnv('SHARED_SECRET').SHARED_SECRET;
  const row = await prisma.authorizationCode.findUnique({
    where: { codeHash: hashCode(params.code, sharedSecret) },
    select: {
      id: true,
      userId: true,
      oauthClientId: true,
      redirectUrl: true,
      resource: true,
      codeChallenge: true,
      codeChallengeMethod: true,
      rememberMe: true,
      expiresAt: true,
      usedAt: true,
    },
  });

  // Opaque rejection for every failure (no oracle), matching token.service.
  const reject = (): never => {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  };

  if (!row || !row.oauthClientId) reject();
  // Non-null after the guard above.
  const code = row as NonNullable<typeof row>;
  if (code.oauthClientId !== params.oauthClientId) reject();
  if (code.redirectUrl !== params.redirectUrl) reject();
  if (!code.codeChallenge || code.codeChallengeMethod !== 'S256') reject();
  try {
    verifyPkceCodeVerifier({ codeVerifier: params.codeVerifier, codeChallenge: code.codeChallenge ?? '' });
  } catch {
    reject();
  }
  if (code.usedAt) reject();
  if (code.expiresAt.getTime() <= now.getTime()) reject();

  // One-time use: atomic compare-and-set guards against code replay / races.
  const updated = await prisma.authorizationCode.updateMany({
    where: { id: code.id, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (updated.count !== 1) reject();

  return { userId: code.userId, resource: code.resource, rememberMe: code.rememberMe };
}
