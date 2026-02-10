import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { AUTHORIZATION_CODE_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

type TokenPrisma = {
  authorizationCode: Pick<PrismaClient['authorizationCode'], 'create'>;
};

type TokenDeps = {
  prisma?: TokenPrisma;
  now?: () => Date;
  sharedSecret?: string;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function generateAuthorizationCode(): string {
  // 32 bytes -> 256 bits of entropy; base64url for safe transport in URLs.
  return randomBytes(32).toString('base64url');
}

function hashAuthorizationCode(code: string, pepper: string): string {
  // Store only a hashed code. The raw code is a bearer secret; treat it like email tokens.
  return sha256Hex(`${code}.${pepper}`);
}

function parseHttpUrl(value: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_REDIRECT_URL');
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_REDIRECT_URL');
  }

  if (!u.hostname) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_REDIRECT_URL');
  }

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

