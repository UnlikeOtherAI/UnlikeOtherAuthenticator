import type { PrismaClient } from '@prisma/client';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
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
import { getActiveClientOrgContext } from './org-context.service.js';
import {
  CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS,
  consumeConfidentialAssertion,
} from './confidential-assertion-use.service.js';
import { resolveConfidentialDelegation } from './confidential-delegation.service.js';
import { lockTokenIssuanceProductPolicy } from './product-workspace-policy-lock.service.js';
import { resolveProductWorkspacePolicy } from './product-workspace-policy.service.js';
import { requiresExactAuthorizationWorkspace } from './required-workspace-placement.service.js';
import {
  isAuthenticationEpochMismatchError,
  lockAndAssertAuthenticationEpoch,
} from './authentication-epoch.service.js';

export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const JWT_SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
export const ACCESS_TOKEN_ISSUED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS = 5 * 60;

export const SUBJECT_ASSERTION_MAX_TTL_SECONDS = 60;
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
    tv: z.number().int().nonnegative(),
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
  scope: string;
}

type ExchangeDeps = {
  prisma?: PrismaClient;
  fetchJwks?: (jwksUrl: string, opts: { expectedHost: string }) => Promise<PublicRsaJwks>;
  now?: () => number;
  signAccessToken?: (claims: ConfidentialAccessTokenClaims) => Promise<string>;
  consumeAssertion?: typeof consumeConfidentialAssertion;
  consumeSubjectRateLimit?: (key: string) => void;
  resolveDelegation?: typeof resolveConfidentialDelegation;
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
      clockTolerance: CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS,
    });
    const assertion = SubjectAssertionSchema.parse(payload);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);

    if (
      assertion.iss !== sourceDomain ||
      assertion.aud !== params.audience ||
      assertion.source_domain !== sourceDomain ||
      assertion.exp <= assertion.iat ||
      assertion.exp - assertion.iat > SUBJECT_ASSERTION_MAX_TTL_SECONDS ||
      assertion.iat > now + CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS
    ) {
      throw invalidSubjectToken();
    }

    return assertion;
  } catch {
    throw invalidSubjectToken();
  }
}

async function exchangeConfidentialSubjectTokenInsidePolicyLock(
  params: {
    authenticatedClientDomainId: string;
    subjectToken: string;
    product: string;
    resource: string;
    scope: string;
    config: ClientConfig;
    configJwt: string;
  },
  verified: {
    assertion: VerifiedSubjectAssertion;
    issuer: string;
    sourceDomain: string;
  },
  deps: ExchangeDeps = {},
): Promise<ConfidentialTokenExchangeResult> {
  const delegation = await (deps.resolveDelegation ?? resolveConfidentialDelegation)(
    {
      authenticatedClientDomainId: params.authenticatedClientDomainId,
      sourceDomain: verified.sourceDomain,
      product: params.product,
      resource: params.resource,
      scope: params.scope,
    },
    { prisma: deps.prisma },
  );
  const { assertion, issuer, sourceDomain } = verified;
  const credentialEpoch = assertion.tv;

  const prisma = deps.prisma ?? getAdminPrisma();
  try {
    await lockAndAssertAuthenticationEpoch(
      { userId: assertion.sub, domain: sourceDomain, credentialEpoch },
      { prisma },
    );
  } catch (error) {
    // Keep user existence and current epoch opaque to an authenticated source
    // product; this is the same failure class as a missing source-domain role.
    if (isAuthenticationEpochMismatchError(error)) {
      throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
    }
    throw error;
  }
  const workspacePolicy = await resolveProductWorkspacePolicy({ domain: sourceDomain }, { prisma });
  if (!assertion.active && requiresExactAuthorizationWorkspace(params.config, workspacePolicy)) {
    throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
  }
  if (assertion.active && !params.config.org_features?.enabled) {
    if (workspacePolicy.scope !== 'all_active_memberships') {
      throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
    }
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
      ? getActiveClientOrgContext(
          {
            userId: assertion.sub,
            domain: sourceDomain,
            orgId: assertion.active.orgId,
            groupsEnabled: params.config.org_features?.groups_enabled,
          },
          { crossProductPrisma: prisma, policyPrisma: prisma, prisma },
        )
      : Promise.resolve(null),
  ]);

  if (!user || !domainRole) {
    throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
  }
  if (assertion.active && (!org || !org.teams.includes(assertion.active.teamId))) {
    throw new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
  }

  const nowSeconds = deps.now;
  await (deps.consumeAssertion ?? consumeConfidentialAssertion)(
    {
      expiresAtEpochSeconds: assertion.exp,
      jti: assertion.jti,
      sourceDomain,
    },
    {
      prisma,
      ...(nowSeconds ? { now: () => new Date(nowSeconds() * 1000) } : {}),
    },
  );

  const workspaceClaims = assertion.active && org ? { org, active: assertion.active } : {};

  const accessToken = await (deps.signAccessToken ?? signConfidentialAccessToken)({
    subject: assertion.sub,
    credentialEpoch,
    email: user.email,
    sourceDomain,
    product: delegation.product,
    resource: delegation.resource,
    issuer,
    ttlSeconds: CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS,
    scope: delegation.scope,
    ...workspaceClaims,
  });

  return {
    accessToken,
    expiresInSeconds: CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS,
    issuedTokenType: ACCESS_TOKEN_ISSUED_TOKEN_TYPE,
    scope: delegation.scope,
  };
}

export async function exchangeConfidentialSubjectToken(
  params: {
    authenticatedClientDomainId: string;
    subjectToken: string;
    product: string;
    resource: string;
    scope: string;
    config: ClientConfig;
    configJwt: string;
  },
  deps: ExchangeDeps = {},
): Promise<ConfidentialTokenExchangeResult> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const sourceDomain = normalizeDomain(params.config.domain);
  const resolveDelegation = deps.resolveDelegation ?? resolveConfidentialDelegation;
  // Cheap DB preflight preserves fail-fast target rejection. The same mapping
  // is authoritatively re-read under the shared policy lock below.
  await resolveDelegation(
    {
      authenticatedClientDomainId: params.authenticatedClientDomainId,
      sourceDomain,
      product: params.product,
      resource: params.resource,
      scope: params.scope,
    },
    { prisma },
  );
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

  return runInTransaction(prisma, async (tx) => {
    await lockTokenIssuanceProductPolicy(
      { clientDomainId: params.authenticatedClientDomainId, domain: params.config.domain },
      { prisma: tx },
    );
    return exchangeConfidentialSubjectTokenInsidePolicyLock(
      params,
      { assertion, issuer, sourceDomain },
      { ...deps, prisma: tx, resolveDelegation },
    );
  });
}
