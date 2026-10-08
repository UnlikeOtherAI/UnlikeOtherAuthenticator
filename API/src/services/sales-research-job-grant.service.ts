import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { asPrismaClient } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { isAuthenticationEpochMismatchError, lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { consumeConfidentialAssertion } from './confidential-assertion-use.service.js';
import { resolveConfidentialDelegation } from './confidential-delegation.service.js';
import {
  verifyConfidentialSubjectToken,
  type VerifiedSubjectAssertion,
} from './confidential-token-exchange.service.js';
import type { PublicRsaJwks } from './client-jwk.service.js';
import { getActiveClientOrgContext } from './org-context.service.js';
import { signConfidentialAccessToken } from './oauth/access-token.service.js';
import { lockProductTeamPolicyShared, lockTokenIssuanceProductPolicy } from './product-team-policy-lock.service.js';

export const SALES_RESEARCH_JOB_PRODUCT = 'salesnerd';
export const SALES_RESEARCH_JOB_RESOURCE = 'https://ledger.unlikeotherai.com';
export const SALES_RESEARCH_JOB_PURPOSE = 'research_job';
export const SALES_RESEARCH_JOB_GRANT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SALES_RESEARCH_JOB_TOKEN_TTL_SECONDS = 120;
export const SALES_RESEARCH_JOB_GRANT_AUDIENCE_PATH = '/auth/job-grants';

const Uuid = z.string().uuid();
const JobId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
const JobAuthorizationClaim = z.object({
  request_id: Uuid,
  job_id: JobId,
  product: z.literal(SALES_RESEARCH_JOB_PRODUCT),
  resource: z.literal(SALES_RESEARCH_JOB_RESOURCE),
  purpose: z.literal(SALES_RESEARCH_JOB_PURPOSE),
  authorized_until: z.number().int().positive(),
}).strict();

type Grant = NonNullable<Awaited<ReturnType<PrismaClient['salesResearchJobGrant']['findUnique']>>>;
type GrantIdentity = z.infer<typeof JobAuthorizationClaim> & {
  clientDomainId: string;
  sourceDomain: string;
  subjectId: string;
  orgId: string;
  teamId: string;
  tokenVersion: number;
  originTokenJti: string;
};

function unavailable(): never {
  throw new AppError('FORBIDDEN', 403, 'JOB_GRANT_UNAVAILABLE');
}

function invalidRequest(): never {
  throw new AppError('BAD_REQUEST', 400, 'JOB_GRANT_REQUEST_INVALID');
}

function requestConflict(): never {
  throw new AppError('BAD_REQUEST', 409, 'JOB_GRANT_REQUEST_CONFLICT');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function bindingHash(input: GrantIdentity): string {
  return hash(JSON.stringify([
    input.clientDomainId, input.sourceDomain, input.request_id, input.job_id,
    input.subjectId, input.orgId, input.teamId, input.tokenVersion,
    input.product, input.resource, input.purpose, input.authorized_until,
  ]));
}

function assertClaimMatchesRow(row: Grant, identity: GrantIdentity): boolean {
  return row.clientDomainId === identity.clientDomainId
    && row.sourceDomain === identity.sourceDomain
    && row.requestId === identity.request_id
    && row.jobId === identity.job_id
    && row.subjectId === identity.subjectId
    && row.orgId === identity.orgId
    && row.teamId === identity.teamId
    && row.tokenVersion === identity.tokenVersion
    && row.product === identity.product
    && row.resource === identity.resource
    && row.purpose === identity.purpose
    && row.authorizedUntil.getTime() === identity.authorized_until * 1000
    && row.bindingHash === bindingHash(identity);
}

function isRetryableTransactionConflict(error: unknown): boolean {
  const candidate = error as { code?: string; meta?: { code?: string } };
  return ['P2002', 'P2034'].includes(candidate.code ?? '')
    || (candidate.code === 'P2010' && candidate.meta?.code === '40001');
}

async function serializable<T>(db: PrismaClient,
  action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isRetryableTransactionConflict(error)) throw error;
      if (attempt === 4) throw new AppError('INTERNAL', 503, 'JOB_GRANT_RETRY_EXHAUSTED');
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
  throw new AppError('INTERNAL', 503, 'JOB_GRANT_RETRY_EXHAUSTED');
}

function parseJobClaim(assertion: VerifiedSubjectAssertion, requestId: string, now: Date) {
  const parsed = JobAuthorizationClaim.safeParse(assertion.job_authorization);
  if (!parsed.success || parsed.data.request_id !== requestId) invalidRequest();
  const authorizedUntil = new Date(parsed.data.authorized_until * 1000);
  if (!Number.isFinite(authorizedUntil.getTime())
    || authorizedUntil.getTime() <= now.getTime()
    || authorizedUntil.getTime() > now.getTime() + SALES_RESEARCH_JOB_GRANT_MAX_TTL_MS) {
    invalidRequest();
  }
  return { ...parsed.data, authorizedUntil };
}

async function assertCurrentJobAuthority(
  tx: Prisma.TransactionClient,
  args: {
    clientDomainId: string;
    sourceDomain: string;
    config: { org_features?: { enabled?: boolean; groups_enabled?: boolean } };
    subjectId: string;
    orgId: string;
    teamId: string;
    tokenVersion: number;
  },
): Promise<{ email: string; org: NonNullable<Awaited<ReturnType<typeof getActiveClientOrgContext>>> }> {
  const prisma = asPrismaClient(tx);
  try {
    await lockAndAssertAuthenticationEpoch({ userId: args.subjectId,
      domain: args.sourceDomain, credentialEpoch: args.tokenVersion }, { prisma: tx });
  } catch (error) {
    if (isAuthenticationEpochMismatchError(error)) return unavailable();
    throw error;
  }
  await lockProductTeamPolicyShared(tx);
  await lockTokenIssuanceProductPolicy({ clientDomainId: args.clientDomainId,
    domain: args.sourceDomain }, { prisma });
  await resolveConfidentialDelegation({ authenticatedClientDomainId: args.clientDomainId,
    sourceDomain: args.sourceDomain, product: SALES_RESEARCH_JOB_PRODUCT,
    resource: SALES_RESEARCH_JOB_RESOURCE, scope: 'ai.invoke' }, { prisma });

  const [user, domainRole, org] = await Promise.all([
    tx.user.findFirst({ where: { id: args.subjectId, lifecycleStatus: 'ACTIVE' },
      select: { email: true } }),
    tx.domainRole.findUnique({ where: { domain_userId: { domain: args.sourceDomain,
      userId: args.subjectId } }, select: { role: true } }),
    getActiveClientOrgContext({ userId: args.subjectId, domain: args.sourceDomain,
      orgId: args.orgId, groupsEnabled: args.config.org_features?.groups_enabled },
    { crossProductPrisma: prisma, policyPrisma: prisma, prisma }),
  ]);
  if (!user?.email || !domainRole || !org || !org.teams.includes(args.teamId)) unavailable();
  return { email: user.email, org };
}

export async function issueSalesResearchJobGrant(
  params: {
    clientDomainId: string;
    sourceDomain: string;
    configJwt: string;
    config: { org_features?: { enabled?: boolean; groups_enabled?: boolean } };
    requestId: string;
    subjectToken: string;
  },
  deps: {
    prisma?: PrismaClient;
    now?: () => number;
    fetchJwks?: (jwksUrl: string, opts: { expectedHost: string }) => Promise<PublicRsaJwks>;
  } = {},
): Promise<{ grantHandle: string; expiresAt: string; created: boolean }> {
  if (!Uuid.safeParse(params.requestId).success || !params.clientDomainId) invalidRequest();
  const assertionNowSeconds = deps.now?.() ?? Math.floor(Date.now() / 1000);
  let assertion: VerifiedSubjectAssertion;
  try {
    assertion = await verifyConfidentialSubjectToken({
      subjectToken: params.subjectToken, configJwt: params.configJwt,
      sourceDomain: params.sourceDomain,
      audience: `${getPublicBaseUrl()}${SALES_RESEARCH_JOB_GRANT_AUDIENCE_PATH}`,
    }, { now: () => assertionNowSeconds, fetchJwks: deps.fetchJwks });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_SUBJECT_TOKEN');
  }
  const now = new Date((deps.now?.() ?? Math.floor(Date.now() / 1000)) * 1000);
  if (!assertion.active || assertion.source_domain !== params.sourceDomain) invalidRequest();
  const claim = parseJobClaim(assertion, params.requestId, now);
  const identity: GrantIdentity = {
    ...claim,
    clientDomainId: params.clientDomainId,
    sourceDomain: params.sourceDomain,
    subjectId: assertion.sub,
    orgId: assertion.active.orgId,
    teamId: assertion.active.teamId,
    tokenVersion: assertion.tv,
    originTokenJti: assertion.jti,
  };
  const db = deps.prisma ?? getAdminPrisma();
  const outcome = await serializable(db, async (tx) => {
    const current = await assertCurrentJobAuthority(tx, {
      clientDomainId: identity.clientDomainId, sourceDomain: identity.sourceDomain,
      config: params.config, subjectId: identity.subjectId, orgId: identity.orgId,
      teamId: identity.teamId, tokenVersion: identity.tokenVersion,
    });
    void current;
    const lineageKey = `${identity.product}:${identity.job_id}:${identity.purpose}`;
    await tx.$queryRaw<Array<{ locked: number }>>(Prisma.sql`
      WITH acquired AS (SELECT pg_advisory_xact_lock(hashtextextended(${lineageKey}, 0)))
      SELECT 1::int AS locked FROM acquired`);
    const existing = await tx.salesResearchJobGrant.findFirst({
      where: { clientDomainId: identity.clientDomainId, product: identity.product,
        requestId: identity.request_id },
    });
    const generations = await tx.salesResearchJobGrant.findMany({
      where: { product: identity.product, jobId: identity.job_id, purpose: identity.purpose },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (generations.some((generation) => generation.clientDomainId !== identity.clientDomainId
      || generation.sourceDomain !== identity.sourceDomain
      || generation.subjectId !== identity.subjectId || generation.orgId !== identity.orgId
      || generation.teamId !== identity.teamId || generation.product !== identity.product
      || generation.resource !== identity.resource || generation.purpose !== identity.purpose)) {
      requestConflict();
    }
    if (existing) {
      if (existing.jobId !== identity.job_id || !assertClaimMatchesRow(existing, identity)) {
        requestConflict();
      }
      if (existing.revokedAt || existing.authorizedUntil <= now) unavailable();
      return { row: existing, created: false };
    }
    if (generations.some((generation) => !generation.revokedAt
      && generation.authorizedUntil > now
      && generation.tokenVersion === identity.tokenVersion)) requestConflict();
    await consumeConfidentialAssertion({ expiresAtEpochSeconds: assertion.exp,
      jti: assertion.jti, sourceDomain: params.sourceDomain }, { prisma: asPrismaClient(tx), now: () => now });
    const row = await tx.salesResearchJobGrant.create({ data: {
      clientDomainId: identity.clientDomainId, requestId: identity.request_id,
      jobId: identity.job_id, sourceDomain: identity.sourceDomain,
      subjectId: identity.subjectId, orgId: identity.orgId, teamId: identity.teamId,
      tokenVersion: identity.tokenVersion, originTokenJti: identity.originTokenJti,
      product: identity.product, resource: identity.resource, purpose: identity.purpose,
      bindingHash: bindingHash(identity), authorizedUntil: claim.authorizedUntil,
      createdAt: now,
    } });
    return { row, created: true };
  });
  return { grantHandle: outcome.row.id, expiresAt: outcome.row.authorizedUntil.toISOString(),
    created: outcome.created };
}

async function lockGrant(tx: Prisma.TransactionClient, grantHandle: string): Promise<Grant> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM sales_research_job_grants WHERE id = ${grantHandle}::uuid FOR UPDATE`);
  const row = await tx.salesResearchJobGrant.findUnique({ where: { id: grantHandle } });
  if (!row) return unavailable();
  return row;
}

function assertCallerBound(row: Grant, input: { clientDomainId: string; sourceDomain: string;
  requestId: string; jobId: string }): void {
  if (row.clientDomainId !== input.clientDomainId || row.sourceDomain !== input.sourceDomain
    || row.requestId !== input.requestId || row.jobId !== input.jobId
    || row.product !== SALES_RESEARCH_JOB_PRODUCT || row.resource !== SALES_RESEARCH_JOB_RESOURCE
    || row.purpose !== SALES_RESEARCH_JOB_PURPOSE) unavailable();
}

export async function renewSalesResearchJobGrant(
  params: { grantHandle: string; clientDomainId: string; sourceDomain: string;
    config: { org_features?: { enabled?: boolean; groups_enabled?: boolean } };
    requestId: string; jobId: string },
  deps: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ accessToken: string; expiresIn: number }> {
  if (!Uuid.safeParse(params.grantHandle).success || !Uuid.safeParse(params.requestId).success
    || !JobId.safeParse(params.jobId).success) invalidRequest();
  const db = deps.prisma ?? getAdminPrisma();
  const hint = await db.salesResearchJobGrant.findFirst({
    where: { id: params.grantHandle, clientDomainId: params.clientDomainId,
      sourceDomain: params.sourceDomain },
    select: { subjectId: true, sourceDomain: true, tokenVersion: true },
  });
  if (!hint) unavailable();
  const now = deps.now ?? new Date();
  return serializable(db, async (tx) => {
    try {
      await lockAndAssertAuthenticationEpoch({ userId: hint.subjectId,
        domain: hint.sourceDomain, credentialEpoch: hint.tokenVersion }, { prisma: tx });
    } catch (error) {
      if (isAuthenticationEpochMismatchError(error)) return unavailable();
      throw error;
    }
    const row = await lockGrant(tx, params.grantHandle);
    assertCallerBound(row, { clientDomainId: params.clientDomainId,
      sourceDomain: params.sourceDomain, requestId: params.requestId, jobId: params.jobId });
    if (row.subjectId !== hint.subjectId || row.tokenVersion !== hint.tokenVersion
      || row.revokedAt || row.authorizedUntil <= now) unavailable();
    const current = await assertCurrentJobAuthority(tx, {
      clientDomainId: row.clientDomainId, sourceDomain: row.sourceDomain,
      config: params.config, subjectId: row.subjectId, orgId: row.orgId,
      teamId: row.teamId, tokenVersion: row.tokenVersion,
    });
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const expiresAt = Math.min(Math.floor(row.authorizedUntil.getTime() / 1000),
      nowSeconds + SALES_RESEARCH_JOB_TOKEN_TTL_SECONDS);
    if (expiresAt <= nowSeconds) unavailable();
    const accessToken = await signConfidentialAccessToken({
      subject: row.subjectId, credentialEpoch: row.tokenVersion, email: current.email,
      sourceDomain: row.sourceDomain, product: row.product, resource: row.resource,
      issuer: getPublicBaseUrl(), ttlSeconds: SALES_RESEARCH_JOB_TOKEN_TTL_SECONDS,
      expiresAtEpochSeconds: expiresAt, scope: 'ai.invoke', org: current.org,
      active: { orgId: row.orgId, teamId: row.teamId },
      jobAuthorization: { grant_handle: row.id, request_id: row.requestId,
        job_id: row.jobId, purpose: 'research_job',
        authorized_until: Math.floor(row.authorizedUntil.getTime() / 1000) },
    });
    return { accessToken, expiresIn: expiresAt - nowSeconds };
  });
}

export async function revokeSalesResearchJobGrant(
  params: { grantHandle: string; clientDomainId: string; sourceDomain: string;
    requestId: string; jobId: string },
  deps: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ revoked: true }> {
  if (!Uuid.safeParse(params.grantHandle).success || !Uuid.safeParse(params.requestId).success
    || !JobId.safeParse(params.jobId).success) invalidRequest();
  const db = deps.prisma ?? getAdminPrisma();
  const now = deps.now ?? new Date();
  await serializable(db, async (tx) => {
    const row = await lockGrant(tx, params.grantHandle);
    assertCallerBound(row, { clientDomainId: params.clientDomainId,
      sourceDomain: params.sourceDomain, requestId: params.requestId, jobId: params.jobId });
    if (!row.revokedAt) await tx.salesResearchJobGrant.update({
      where: { id: row.id }, data: { revokedAt: now },
    });
  });
  return { revoked: true };
}
