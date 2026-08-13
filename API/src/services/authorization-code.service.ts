import { createHmac, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { AUTHORIZATION_CODE_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { getAppLogger } from '../utils/app-logger.js';
import { tryParseRedirectUrl } from '../utils/http-url.js';
import { verifyPkceCodeVerifier } from '../utils/pkce.js';
import {
  isAuthenticationEpochMismatchError,
  lockAndAssertAuthenticationEpoch,
} from './authentication-epoch.service.js';
import { lockProductWorkspacePolicyShared } from './product-workspace-policy-lock.service.js';
import { lockAndAssertActiveClientWorkspaceScope } from './workspace-scope.service.js';
import type { ProductWorkspacePolicyPrisma } from './product-workspace-policy.service.js';

type AuthorizationCodePrisma = PrismaClient;

type AuthorizationCodeDeps = {
  crossProductPrisma?: AuthorizationCodePrisma;
  policyPrisma?: ProductWorkspacePolicyPrisma;
  prisma?: AuthorizationCodePrisma;
  now?: () => Date;
  sharedSecret?: string;
  afterAuthenticationEpochLock?: () => Promise<void>;
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
    twoFaCompleted: boolean;
    credentialEpoch: number;
    // Workspace scope resolved by explicit selection, auto-selection, or the
    // server-owned recognized-product placement performed before 2FA.
    orgId?: string;
    teamId?: string;
  },
  deps?: AuthorizationCodeDeps,
): Promise<{ code: string }> {
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as AuthorizationCodePrisma);
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;

  parseRedirectUrl(params.redirectUrl);

  if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') {
    throw new AppError('BAD_REQUEST', 400, 'PKCE_REQUIRED');
  }

  return runInTransaction(prisma, async (tx) => {
    // Preserve the estate-wide order used by token exchange and credential writers. A caller
    // already inside this hierarchy simply re-enters the transaction-scoped advisory locks.
    await lockProductWorkspacePolicyShared(tx);
    await lockAndAssertAuthenticationEpoch(
      {
        userId: params.userId,
        domain: params.domain,
        credentialEpoch: params.credentialEpoch,
      },
      { prisma: tx, afterLock: deps?.afterAuthenticationEpochLock },
    );

    // Revalidate immediately before the issuance write. This is the final boundary reached after
    // chooser, 2FA, forced enrollment, or signatures, and it follows the user lock hierarchy.
    await lockAndAssertActiveClientWorkspaceScope(
      {
        userId: params.userId,
        domain: params.domain,
        orgId: params.orgId,
        teamId: params.teamId,
      },
      {
        crossProductPrisma: deps?.crossProductPrisma ?? tx,
        policyPrisma: deps?.policyPrisma ?? tx,
        prisma: tx,
      },
    );

    const now = deps?.now ? deps.now() : new Date();
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateAuthorizationCode();
      const codeHash = hashAuthorizationCode(code, sharedSecret);
      const expiresAt = new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS);

      try {
        await tx.authorizationCode.create({
          data: {
            codeHash,
            userId: params.userId,
            domain: params.domain,
            configUrl: params.configUrl,
            redirectUrl: params.redirectUrl,
            codeChallenge: params.codeChallenge,
            codeChallengeMethod: params.codeChallengeMethod,
            rememberMe: params.rememberMe ?? false,
            twoFaCompleted: params.twoFaCompleted,
            tokenVersion: params.credentialEpoch,
            orgId: params.orgId ?? null,
            teamId: params.teamId ?? null,
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
  });
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
  crossProductPrisma?: AuthorizationCodePrisma;
  policyPrisma?: ProductWorkspacePolicyPrisma;
  afterAuthenticationEpochLock?: () => Promise<void>;
  afterActiveScopeLock?: () => Promise<void>;
}): Promise<{
  userId: string;
  rememberMe: boolean;
  twoFaCompleted: boolean;
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
      twoFaCompleted: true,
      tokenVersion: true,
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
  if (row.domain !== params.domain) rejectAuthCode('domain_mismatch', { rowDomain: row.domain });
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
  const credentialEpoch = row.tokenVersion ?? rejectAuthCode('credential_epoch_missing');
  if (!Number.isSafeInteger(credentialEpoch) || credentialEpoch < 0) {
    rejectAuthCode('credential_epoch_missing');
  }

  try {
    await lockAndAssertAuthenticationEpoch(
      {
        userId: row.userId,
        domain: row.domain,
        credentialEpoch,
      },
      { prisma: params.prisma, afterLock: params.afterAuthenticationEpochLock },
    );
  } catch (error) {
    if (isAuthenticationEpochMismatchError(error)) {
      rejectAuthCode('credential_epoch_mismatch');
    }
    throw error;
  }

  try {
    // A code must not create a scoped session after the selected membership was
    // suspended or removed between issuance and exchange.
    await lockAndAssertActiveClientWorkspaceScope(
      {
        userId: row.userId,
        domain: row.domain,
        orgId: row.orgId,
        teamId: row.teamId,
      },
      {
        crossProductPrisma: params.crossProductPrisma,
        policyPrisma: params.policyPrisma,
        prisma: params.prisma,
      },
    );
  } catch {
    rejectAuthCode('workspace_scope_inactive');
  }
  await params.afterActiveScopeLock?.();

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
    twoFaCompleted: row.twoFaCompleted,
    orgId: row.orgId ?? null,
    teamId: row.teamId ?? null,
  };
}
