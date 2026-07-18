import type { PrismaClient } from '@prisma/client';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

import { getEnv, getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { createKeyedRateLimiter } from '../middleware/rate-limiter.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { findJwkByKid, importClientJwkKey, type PublicRsaJwks } from './client-jwk.service.js';
import type { ClientConfig } from './config.service.js';
import { fetchPartnerJwks } from './jwks-fetch.service.js';
import {
  signConfidentialAccessToken,
  type ConfidentialAccessTokenClaims,
} from './oauth/access-token.service.js';
import { getUserOrgContext } from './org-context.service.js';

export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const JWT_SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
export const ACCESS_TOKEN_ISSUED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const CONFIDENTIAL_ACCESS_TOKEN_SCOPE = 'ai.invoke';

export const SUBJECT_ASSERTION_MAX_TTL_SECONDS = 60;
const SUBJECT_ASSERTION_CLOCK_TOLERANCE_SECONDS = 5;
export const CONFIDENTIAL_SUBJECT_RATE_LIMIT_PER_MINUTE = 60;

const consumeSubjectExchange = createKeyedRateLimiter({
  limit: CONFIDENTIAL_SUBJECT_RATE_LIMIT_PER_MINUTE,
  windowMs: 60 * 1000,
});

const ConfigJwksLocationSchema = z.object({
  domain: z.string().trim().min(1),
  jwks_url: z.string().trim().url(),
});

const SubjectAssertionSchema = z
  .object({
    iss: z.string().trim().min(1),
    aud: z.string().trim().min(1),
    sub: z.string().trim().min(1).max(256),
    source_domain: z.string().trim().min(1),
    jti: z.string().trim().min(1).max(256),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    active: z
      .object({
        orgId: z.string().trim().min(1).max(256),
        teamId: z.string().trim().min(1).max(256),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type VerifiedSubjectAssertion = z.infer<typeof SubjectAssertionSchema>;

export interface ConfidentialTokenExchangeResult {
  accessToken: string;
  expiresInSeconds: number;
  issuedTokenType: typeof ACCESS_TOKEN_ISSUED_TOKEN_TYPE;
  scope: typeof CONFIDENTIAL_ACCESS_TOKEN_SCOPE;
}

type ExchangeDeps = {
  prisma?: PrismaClient;
  fetchJwks?: (jwksUrl: string, opts: { expectedHost: string }) => Promise<PublicRsaJwks>;
  now?: () => number;
  signAccessToken?: (claims: ConfidentialAccessTokenClaims) => Promise<string>;
  consumeSubjectRateLimit?: (key: string) => void;
};

function invalidSubjectToken(): AppError {
  return new AppError('UNAUTHORIZED', 401, 'INVALID_SUBJECT_TOKEN');
}

function getConfigJwksUrl(configJwt: string, sourceDomain: string): string {
  try {
    const parsed = ConfigJwksLocationSchema.parse(decodeJwt(configJwt));
    if (normalizeDomain(parsed.domain) !== sourceDomain) {
      throw invalidSubjectToken();
    }
    return parsed.jwks_url;
  } catch {
    throw invalidSubjectToken();
  }
}

function getAllowedTarget(): { sourceDomain: string; resource: string } {
  const env = getEnv();
  const configuredSource = env.CONFIDENTIAL_TOKEN_EXCHANGE_SOURCE_DOMAIN?.trim();
  const configuredResource = env.CONFIDENTIAL_TOKEN_EXCHANGE_RESOURCE?.trim();
  if (!configuredSource || !configuredResource) {
    throw new AppError('INTERNAL', 500, 'CONFIDENTIAL_TOKEN_EXCHANGE_DISABLED');
  }

  let resourceUrl: URL;
  try {
    resourceUrl = new URL(configuredResource);
  } catch {
    throw new AppError('INTERNAL', 500, 'CONFIDENTIAL_TOKEN_EXCHANGE_CONFIG_INVALID');
  }
  if (
    resourceUrl.protocol !== 'https:' ||
    resourceUrl.username ||
    resourceUrl.password ||
    resourceUrl.hash
  ) {
    throw new AppError('INTERNAL', 500, 'CONFIDENTIAL_TOKEN_EXCHANGE_CONFIG_INVALID');
  }

  const sourceDomain = normalizeDomain(configuredSource);
  if (!sourceDomain) {
    throw new AppError('INTERNAL', 500, 'CONFIDENTIAL_TOKEN_EXCHANGE_CONFIG_INVALID');
  }
  return { sourceDomain, resource: configuredResource };
}

export async function verifyConfidentialSubjectToken(
  params: {
    subjectToken: string;
    configJwt: string;
    sourceDomain: string;
    audience: string;
  },
  deps: Pick<ExchangeDeps, 'fetchJwks' | 'now'> = {},
): Promise<VerifiedSubjectAssertion> {
  const sourceDomain = normalizeDomain(params.sourceDomain);
  if (!sourceDomain) throw invalidSubjectToken();

  try {
    const header = decodeProtectedHeader(params.subjectToken);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
      throw invalidSubjectToken();
    }

    const jwksUrl = getConfigJwksUrl(params.configJwt, sourceDomain);
    const jwks = await (deps.fetchJwks ?? fetchPartnerJwks)(jwksUrl, {
      expectedHost: sourceDomain,
    });
    const jwk = findJwkByKid(jwks, header.kid);
    if (!jwk || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) {
      throw invalidSubjectToken();
    }

    const publicKey = await importClientJwkKey(jwk);
    const { payload } = await jwtVerify(params.subjectToken, publicKey, {
      algorithms: ['RS256'],
      issuer: sourceDomain,
      audience: params.audience,
      clockTolerance: SUBJECT_ASSERTION_CLOCK_TOLERANCE_SECONDS,
    });
    const assertion = SubjectAssertionSchema.parse(payload);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);

    if (
      assertion.iss !== sourceDomain ||
      assertion.aud !== params.audience ||
      assertion.source_domain !== sourceDomain ||
      assertion.exp <= assertion.iat ||
      assertion.exp - assertion.iat > SUBJECT_ASSERTION_MAX_TTL_SECONDS ||
      assertion.iat > now + SUBJECT_ASSERTION_CLOCK_TOLERANCE_SECONDS
    ) {
      throw invalidSubjectToken();
    }

    return assertion;
  } catch {
    throw invalidSubjectToken();
  }
}

export async function exchangeConfidentialSubjectToken(
  params: {
    subjectToken: string;
    resource: string;
    config: ClientConfig;
    configJwt: string;
  },
  deps: ExchangeDeps = {},
): Promise<ConfidentialTokenExchangeResult> {
  const allowed = getAllowedTarget();
  const sourceDomain = normalizeDomain(params.config.domain);
  if (sourceDomain !== allowed.sourceDomain || params.resource !== allowed.resource) {
    throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_TARGET_NOT_ALLOWED');
  }
  const issuer = getPublicBaseUrl();
  const assertion = await verifyConfidentialSubjectToken(
    {
      subjectToken: params.subjectToken,
      configJwt: params.configJwt,
      sourceDomain,
      audience: `${issuer}/auth/token`,
    },
    deps,
  );
  (deps.consumeSubjectRateLimit ?? consumeSubjectExchange)(`${sourceDomain}:${assertion.sub}`);

  const prisma = deps.prisma ?? getAdminPrisma();
  if (assertion.active && !params.config.org_features?.enabled) {
    throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
  }

  const [user, domainRole, org] = await Promise.all([
    prisma.user.findUnique({
      where: { id: assertion.sub },
      select: { email: true },
    }),
    prisma.domainRole.findUnique({
      where: {
        domain_userId: {
          domain: sourceDomain,
          userId: assertion.sub,
        },
      },
      select: { role: true },
    }),
    assertion.active
      ? getUserOrgContext(
          {
            userId: assertion.sub,
            domain: sourceDomain,
            config: params.config,
            orgId: assertion.active.orgId,
          },
          { prisma },
        )
      : Promise.resolve(null),
  ]);

  if (!user || !domainRole) {
    throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
  }
  if (assertion.active && (!org || !org.teams.includes(assertion.active.teamId))) {
    throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
  }

  const workspaceClaims = assertion.active && org ? { org, active: assertion.active } : {};

  const accessToken = await (deps.signAccessToken ?? signConfidentialAccessToken)({
    subject: assertion.sub,
    email: user.email,
    sourceDomain,
    resource: allowed.resource,
    issuer,
    ttlSeconds: CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS,
    scope: CONFIDENTIAL_ACCESS_TOKEN_SCOPE,
    ...workspaceClaims,
  });

  return {
    accessToken,
    expiresInSeconds: CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS,
    issuedTokenType: ACCESS_TOKEN_ISSUED_TOKEN_TYPE,
    scope: CONFIDENTIAL_ACCESS_TOKEN_SCOPE,
  };
}
