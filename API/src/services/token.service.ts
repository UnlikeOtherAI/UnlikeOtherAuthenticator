import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

import { AUTHORIZATION_CODE_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { ensureDomainRoleForUser } from './domain-role.service.js';
import { createClientId } from '../utils/hash.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { tryParseHttpUrl } from '../utils/http-url.js';

type TokenPrisma = {
  authorizationCode: Pick<
    PrismaClient['authorizationCode'],
    'create' | 'findUnique' | 'updateMany'
  >;
  user: Pick<PrismaClient['user'], 'findUnique'>;
  domainRole: PrismaClient['domainRole'];
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

async function consumeAuthorizationCode(params: {
  code: string;
  configUrl: string;
  domain: string;
  now: Date;
  sharedSecret: string;
  prisma: TokenPrisma;
}): Promise<{ userId: string }> {
  const codeHash = hashAuthorizationCode(params.code, params.sharedSecret);
  const row = await params.prisma.authorizationCode.findUnique({
    where: { codeHash },
    select: {
      id: true,
      userId: true,
      domain: true,
      configUrl: true,
      expiresAt: true,
      usedAt: true,
    },
  });

  // Treat all failures as generic auth failure; never leak "expired" vs "unknown" etc.
  if (!row) throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  if (row.domain !== params.domain) throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  if (row.configUrl !== params.configUrl)
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
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

  return { userId: row.userId };
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
}): Promise<string> {
  try {
    return await new SignJWT({
      email: params.email,
      domain: params.domain,
      client_id: params.clientId,
      role: params.role,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(params.issuer)
      .setSubject(params.userId)
      .setIssuedAt()
      .setExpirationTime(params.ttl)
      .sign(sharedSecretKey(params.sharedSecret));
  } catch {
    // Normalize token signing failures into a generic error.
    throw new AppError('INTERNAL', 500, 'TOKEN_SIGN_FAILED');
  }
}

/**
 * Brief 22.13: client backend exchanges the authorization code for an access token JWT.
 */
export async function exchangeAuthorizationCodeForAccessToken(
  params: {
    code: string;
    config: ClientConfig;
    configUrl: string;
  },
  deps?: TokenDeps & { accessTokenTtl?: string; authServiceIdentifier?: string },
): Promise<{ accessToken: string }> {
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const issuer =
    deps?.authServiceIdentifier ?? requireEnv('AUTH_SERVICE_IDENTIFIER').AUTH_SERVICE_IDENTIFIER;
  const ttl = deps?.accessTokenTtl ?? env.ACCESS_TOKEN_TTL;

  const prisma = deps?.prisma ?? (getPrisma() as unknown as TokenPrisma);

  const { userId } = await consumeAuthorizationCode({
    code: params.code,
    configUrl: params.configUrl,
    domain: params.config.domain,
    now,
    sharedSecret,
    prisma,
  });

  // Ensure a per-domain role exists (global users may log in on new domains).
  const domainRole = await ensureDomainRoleForUser({
    prisma: prisma as unknown as PrismaClient,
    domain: params.config.domain,
    userId,
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new AppError('INTERNAL', 500, 'MISSING_USER');

  const role = domainRole.role === 'SUPERUSER' ? 'superuser' : 'user';
  const clientId = createClientId(params.config.domain, sharedSecret);

  const accessToken = await signAccessToken({
    userId,
    email: user.email,
    domain: params.config.domain,
    role,
    clientId,
    sharedSecret,
    ttl,
    issuer,
  });

  return { accessToken };
}
