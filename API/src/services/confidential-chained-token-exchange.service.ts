import type { PrismaClient } from '@prisma/client';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { createKeyedRateLimiter } from '../middleware/rate-limiter.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import {
  parseConfidentialDelegationScope,
  resolveConfidentialDelegation,
  resolveConfidentialDelegationForSource,
} from './confidential-delegation.service.js';
import {
  CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS,
  type ConfidentialTokenExchangeResult,
} from './confidential-token-exchange.service.js';
import {
  getAccessTokenPublicJwks,
  signConfidentialAccessToken,
  type ConfidentialAccessTokenClaims,
  type ConfidentialActorChain,
} from './oauth/access-token.service.js';
import { getActiveClientOrgContext, type OrgContext } from './org-context.service.js';
import { CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS } from './confidential-assertion-use.service.js';
import { lockTokenIssuanceProductPolicy } from './product-workspace-policy-lock.service.js';
import {
  isAuthenticationEpochMismatchError,
  lockAndAssertAuthenticationEpoch,
} from './authentication-epoch.service.js';

export const ACCESS_TOKEN_SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

const MAX_ACTOR_CHAIN_DEPTH = 8;
const PRODUCT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CHAINED_SUBJECT_RATE_LIMIT_PER_MINUTE = 60;

const consumeChainedSubjectExchange = createKeyedRateLimiter({
  limit: CHAINED_SUBJECT_RATE_LIMIT_PER_MINUTE,
  windowMs: 60 * 1000,
});

const ActiveWorkspaceSchema = z
  .object({
    orgId: z.string().trim().min(1).max(256),
    teamId: z.string().trim().min(1).max(256),
  })
  .strict();

const OrgContextSchema = z
  .object({
    org_id: z.string().trim().min(1).max(256),
    org_role: z.string().trim().min(1).max(100),
    teams: z.array(z.string().trim().min(1).max(256)).min(1),
    team_roles: z.record(z.string().trim().min(1).max(100)),
    groups: z.array(z.string().trim().min(1).max(256)).optional(),
    group_admin: z.array(z.string().trim().min(1).max(256)).optional(),
  })
  .strict();

const ChainedSubjectAccessTokenSchema = z
  .object({
    iss: z.string().trim().min(1),
    aud: z.string().trim().min(1),
    sub: z.string().trim().min(1).max(256),
    tv: z.number().int().nonnegative(),
    email: z.string().trim().email(),
    source_domain: z.string().trim().min(1),
    azp: z.string().trim().min(1),
    product: z.string().trim().regex(PRODUCT_PATTERN),
    scope: z.string().trim().min(1).max(256),
    jti: z.string().trim().min(1).max(256),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    active: ActiveWorkspaceSchema,
    org: OrgContextSchema,
    act: z.unknown().optional(),
  })
  .passthrough();

type VerifiedChainedSubjectAccessToken = z.infer<typeof ChainedSubjectAccessTokenSchema> & {
  act?: ConfidentialActorChain;
};

type ChainedExchangeDeps = {
  prisma?: PrismaClient;
  now?: () => number;
  getAccessTokenJwks?: typeof getAccessTokenPublicJwks;
  signAccessToken?: (claims: ConfidentialAccessTokenClaims) => Promise<string>;
  resolveDelegation?: typeof resolveConfidentialDelegation;
  resolveSourceDelegation?: typeof resolveConfidentialDelegationForSource;
  consumeSubjectRateLimit?: (key: string) => void;
};

function invalidSubjectToken(): AppError {
  return new AppError('UNAUTHORIZED', 401, 'INVALID_SUBJECT_TOKEN');
}

function subjectForbidden(): AppError {
  return new AppError('FORBIDDEN', 403, 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN');
}

function parseActorChain(value: unknown, depth = 0): ConfidentialActorChain {
  // Reserve one slot for the authenticated caller added to the downstream token.
  if (depth >= MAX_ACTOR_CHAIN_DEPTH - 1) throw invalidSubjectToken();
  const actor = z
    .object({
      sub: z.string().trim().min(1).max(256),
      product: z.string().trim().regex(PRODUCT_PATTERN),
      act: z.unknown().optional(),
    })
    .strict()
    .parse(value);
  const actorDomain = normalizeDomain(actor.sub);
  if (actor.sub !== actorDomain) throw invalidSubjectToken();
  httpsOriginForDomain(actorDomain);
  return {
    sub: actorDomain,
    product: actor.product,
    ...(actor.act === undefined ? {} : { act: parseActorChain(actor.act, depth + 1) }),
  };
}

function httpsOriginForDomain(value: string): string {
  const domain = normalizeDomain(value);
  try {
    const url = new URL(`https://${domain}`);
    if (!domain || url.hostname !== domain || url.origin !== `https://${domain}`) {
      throw new Error('invalid');
    }
    return url.origin;
  } catch {
    throw invalidSubjectToken();
  }
}

export async function verifyChainedSubjectAccessToken(
  params: {
    subjectToken: string;
    callerAudience: string;
    issuer: string;
  },
  deps: Pick<ChainedExchangeDeps, 'getAccessTokenJwks' | 'now'> = {},
): Promise<VerifiedChainedSubjectAccessToken> {
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  try {
    const header = decodeProtectedHeader(params.subjectToken);
    if (
      header.alg !== 'RS256' ||
      header.typ !== 'at+jwt' ||
      typeof header.kid !== 'string' ||
      !header.kid.trim()
    ) {
      throw invalidSubjectToken();
    }

    const jwks = createLocalJWKSet(await (deps.getAccessTokenJwks ?? getAccessTokenPublicJwks)());
    const { payload } = await jwtVerify(params.subjectToken, jwks, {
      algorithms: ['RS256'],
      audience: params.callerAudience,
      issuer: params.issuer,
      clockTolerance: CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(now * 1000),
    });
    const parsed = ChainedSubjectAccessTokenSchema.parse(payload);
    const sourceDomain = normalizeDomain(parsed.source_domain);
    const scopes = parseConfidentialDelegationScope(parsed.scope);
    const uniqueTeams = new Set(parsed.org.teams);
    httpsOriginForDomain(sourceDomain);

    if (
      parsed.iss !== params.issuer ||
      parsed.aud !== params.callerAudience ||
      !sourceDomain ||
      parsed.source_domain !== sourceDomain ||
      parsed.azp !== sourceDomain ||
      parsed.product !== parsed.product.toLowerCase() ||
      parsed.exp <= parsed.iat ||
      parsed.exp - parsed.iat > CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS ||
      parsed.iat > now + CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS ||
      parsed.exp <= now ||
      parsed.org.org_id !== parsed.active.orgId ||
      uniqueTeams.size !== parsed.org.teams.length ||
      !uniqueTeams.has(parsed.active.teamId) ||
      !parsed.org.team_roles[parsed.active.teamId] ||
      scopes.join(' ') !== parsed.scope
    ) {
      throw invalidSubjectToken();
    }

    const { act, ...claims } = parsed;
    return {
      ...claims,
      ...(act === undefined ? {} : { act: parseActorChain(act) }),
    };
  } catch {
    throw invalidSubjectToken();
  }
}

function originalIdentityDomain(subject: VerifiedChainedSubjectAccessToken): string {
  let domain = subject.source_domain;
  let actor = subject.act;
  while (actor) {
    domain = actor.sub;
    actor = actor.act;
  }
  return domain;
}

function narrowOrgContext(current: OrgContext, inbound: OrgContext): OrgContext {
  const inboundTeams = new Set(inbound.teams);
  const teams = current.teams.filter((teamId) => inboundTeams.has(teamId));
  const teamRoles = Object.fromEntries(teams.map((teamId) => [teamId, current.team_roles[teamId]]));
  return {
    org_id: current.org_id,
    org_role: current.org_role,
    teams,
    team_roles: teamRoles,
  };
}

async function exchangeConfidentialChainedAccessTokenInsidePolicyLock(
  params: {
    authenticatedClientDomainId: string;
    subjectToken: string;
    product: string;
    resource: string;
    scope: string;
    config: ClientConfig;
  },
  verified: {
    callerAudience: string;
    callerDomain: string;
    issuer: string;
    subject: VerifiedChainedSubjectAccessToken;
  },
  deps: ChainedExchangeDeps = {},
): Promise<ConfidentialTokenExchangeResult> {
  const { callerAudience, callerDomain, issuer, subject } = verified;
  const delegation = await (deps.resolveDelegation ?? resolveConfidentialDelegation)(
    {
      authenticatedClientDomainId: params.authenticatedClientDomainId,
      sourceDomain: callerDomain,
      product: params.product,
      resource: params.resource,
      scope: params.scope,
    },
    { prisma: deps.prisma },
  );
  const requestedScopes = parseConfidentialDelegationScope(delegation.scope);
  const inboundScopes = new Set(parseConfidentialDelegationScope(subject.scope));
  if (requestedScopes.some((scope) => !inboundScopes.has(scope))) {
    throw subjectForbidden();
  }

  const prisma = deps.prisma ?? getAdminPrisma();
  const identityDomain = originalIdentityDomain(subject);
  const credentialEpoch = subject.tv;
  try {
    await lockAndAssertAuthenticationEpoch(
      { userId: subject.sub, domain: identityDomain, credentialEpoch },
      { prisma },
    );
  } catch (error) {
    if (isAuthenticationEpochMismatchError(error)) throw subjectForbidden();
    throw error;
  }
  const [sourceDelegation, user, domainRole, currentOrg] = await Promise.all([
    (deps.resolveSourceDelegation ?? resolveConfidentialDelegationForSource)(
      {
        sourceDomain: subject.source_domain,
        product: subject.product,
        resource: callerAudience,
        scope: subject.scope,
      },
      { prisma },
    ),
    prisma.user.findUnique({
      where: { id: subject.sub },
      select: { email: true },
    }),
    prisma.domainRole.findUnique({
      where: {
        domain_userId: {
          domain: identityDomain,
          userId: subject.sub,
        },
      },
      select: { role: true },
    }),
    getActiveClientOrgContext(
      {
        userId: subject.sub,
        domain: identityDomain,
        orgId: subject.active.orgId,
        groupsEnabled: false,
      },
      { crossProductPrisma: prisma, policyPrisma: prisma, prisma },
    ),
  ]);

  if (
    sourceDelegation.product !== subject.product ||
    sourceDelegation.resource !== callerAudience ||
    sourceDelegation.scope !== subject.scope ||
    !user ||
    !domainRole ||
    !currentOrg ||
    currentOrg.org_id !== subject.org.org_id ||
    !currentOrg.teams.includes(subject.active.teamId)
  ) {
    throw subjectForbidden();
  }

  const org = narrowOrgContext(currentOrg, subject.org);
  if (!org.teams.includes(subject.active.teamId)) throw subjectForbidden();

  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const expiresInSeconds = Math.min(CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS, subject.exp - now);
  if (expiresInSeconds <= 0) throw invalidSubjectToken();

  const actor: ConfidentialActorChain = {
    sub: subject.source_domain,
    product: subject.product,
    ...(subject.act ? { act: subject.act } : {}),
  };
  const accessToken = await (deps.signAccessToken ?? signConfidentialAccessToken)({
    subject: subject.sub,
    credentialEpoch,
    email: user.email,
    sourceDomain: callerDomain,
    product: delegation.product,
    resource: delegation.resource,
    issuer,
    ttlSeconds: expiresInSeconds,
    expiresAtEpochSeconds: now + expiresInSeconds,
    scope: delegation.scope,
    org,
    active: subject.active,
    actor,
  });

  return {
    accessToken,
    expiresInSeconds,
    issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    scope: delegation.scope,
  };
}

export async function exchangeConfidentialChainedAccessToken(
  params: {
    authenticatedClientDomainId: string;
    subjectToken: string;
    product: string;
    resource: string;
    scope: string;
    config: ClientConfig;
  },
  deps: ChainedExchangeDeps = {},
): Promise<ConfidentialTokenExchangeResult> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const callerDomain = normalizeDomain(params.config.domain);
  const callerAudience = httpsOriginForDomain(callerDomain);
  const resolveDelegation = deps.resolveDelegation ?? resolveConfidentialDelegation;
  // Reject unsupported targets before verification, then repeat the mapping
  // decision under the policy lock so this preflight never becomes authority.
  await resolveDelegation(
    {
      authenticatedClientDomainId: params.authenticatedClientDomainId,
      sourceDomain: callerDomain,
      product: params.product,
      resource: params.resource,
      scope: params.scope,
    },
    { prisma },
  );
  const issuer = getPublicBaseUrl();
  const subject = await verifyChainedSubjectAccessToken(
    { subjectToken: params.subjectToken, callerAudience, issuer },
    deps,
  );
  (deps.consumeSubjectRateLimit ?? consumeChainedSubjectExchange)(`${callerDomain}:${subject.sub}`);

  return runInTransaction(prisma, async (tx) => {
    await lockTokenIssuanceProductPolicy(
      { clientDomainId: params.authenticatedClientDomainId, domain: params.config.domain },
      { prisma: tx },
    );
    return exchangeConfidentialChainedAccessTokenInsidePolicyLock(
      params,
      { callerAudience, callerDomain, issuer, subject },
      { ...deps, prisma: tx, resolveDelegation },
    );
  });
}
