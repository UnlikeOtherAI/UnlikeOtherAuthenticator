import { createHmac, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { AUTHORIZATION_CODE_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { getAppLogger } from '../utils/app-logger.js';
import { tryParseRedirectUrl } from '../utils/http-url.js';
import { verifyPkceCodeVerifier } from '../utils/pkce.js';

type AuthorizationCodePrisma = PrismaClient;

type AuthorizationCodeDeps = {
  prisma?: AuthorizationCodePrisma;
  now?: () => Date;
  sharedSecret?: string;
};

function generateAuthorizationCode(): string {
  return randomBytes(32).toString('base64url');
}

function hashAuthorizationCode(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code, 'utf8').digest('hex');
}

function parseRedirectUrl(value: string): URL {
  const u = tryParseRedirectUrl(value);
  if (!u) throw new AppError('BAD_REQUEST', 400, 'INVALID_REDIRECT_URL');
  return u;
}

export function selectRedirectUrl(params: {
  allowedRedirectUrls: string[];
  requestedRedirectUrl?: string;
}): string {
  const requested = params.requestedRedirectUrl?.trim();
  if (requested) {
    if (!params.allowedRedirectUrls.includes(requested)) {
      throw new AppError('BAD_REQUEST', 400, 'REDIRECT_URL_NOT_ALLOWED');
    }
    parseRedirectUrl(requested);
    return requested;
  }

  const candidate = params.allowedRedirectUrls[0]?.trim() ?? '';
  if (!candidate) {
    throw new AppError('BAD_REQUEST', 400, 'MISSING_REDIRECT_URL');
  }

  parseRedirectUrl(candidate);
  return candidate;
}

export function buildRedirectToUrl(params: { redirectUrl: string; code: string }): string {
  const u = parseRedirectUrl(params.redirectUrl);
  u.searchParams.set('code', params.code);
  return u.toString();
}

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
  deps?: AuthorizationCodeDeps,
): Promise<{ code: string }> {
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as AuthorizationCodePrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;

  parseRedirectUrl(params.redirectUrl);

  if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') {
    throw new AppError('BAD_REQUEST', 400, 'PKCE_REQUIRED');
  }

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
      if (codeValue === 'P2002') continue;
      throw err;
    }
  }

  throw new AppError('INTERNAL', 500, 'AUTH_CODE_COLLISION');
}

export async function consumeAuthorizationCode(params: {
  code: string;
  configUrl: string;
  domain: string;
  redirectUrl: string;
  codeVerifier?: string;
  now: Date;
  sharedSecret: string;
  prisma: AuthorizationCodePrisma;
}): Promise<{
  userId: string;
  rememberMe: boolean;
  orgId: string | null;
  teamId: string | null;
}> {
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
      orgId: true,
      teamId: true,
    },
  });

  // Authorization-code rejection always surfaces the same opaque
  // INVALID_AUTH_CODE to the client (no oracle), but we log the precise
  // reason server-side so an operator can diagnose a failing first login on a
  // fresh install without guessing. No secrets (code/verifier) are logged.
  const rejectAuthCode = (reason: string, detail?: Record<string, unknown>): never => {
    try {
      getAppLogger().warn(
        { reason, domain: params.domain, configUrl: params.configUrl, ...detail },
        'authorization code rejected',
      );
    } catch {
      // Logger not initialised (e.g. in unit tests) — diagnostics are best-effort
      // and must never change the opaque rejection behaviour below.
    }
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  };

  if (!row) return rejectAuthCode('code_not_found');
  if (row.domain !== params.domain)
    rejectAuthCode('domain_mismatch', { rowDomain: row.domain });
  if (row.configUrl !== params.configUrl)
    rejectAuthCode('config_url_mismatch', { rowConfigUrl: row.configUrl });
  if (row.redirectUrl !== params.redirectUrl)
    rejectAuthCode('redirect_url_mismatch', {
      rowRedirectUrl: row.redirectUrl,
      paramRedirectUrl: params.redirectUrl,
    });
  // PKCE is mandatory at issuance (issueAuthorizationCode throws PKCE_REQUIRED),
  // so it is mandatory at redemption too. Requiring the challenge here — rather
  // than only verifying `if (row.codeChallenge)` — closes a downgrade footgun: a
  // code that ever reached the store without a challenge must never be redeemable
  // without proof of the code_verifier that binds it to the initiating browser.
  if (row.codeChallenge && row.codeChallengeMethod === 'S256') {
    try {
      verifyPkceCodeVerifier({
        codeVerifier: params.codeVerifier,
        codeChallenge: row.codeChallenge,
      });
    } catch {
      rejectAuthCode('pkce_verifier_invalid', {
        codeVerifierPresent: Boolean(params.codeVerifier),
        codeVerifierLength: params.codeVerifier?.length ?? 0,
      });
    }
  } else {
    rejectAuthCode('pkce_required', { method: row.codeChallengeMethod });
  }
  if (row.usedAt) rejectAuthCode('already_used', { usedAt: row.usedAt.toISOString() });
  if (row.expiresAt.getTime() <= params.now.getTime()) rejectAuthCode('expired');

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
    rejectAuthCode('concurrent_consume');
  }

  return {
    userId: row.userId,
    rememberMe: row.rememberMe,
    orgId: row.orgId ?? null,
    teamId: row.teamId ?? null,
  };
}
