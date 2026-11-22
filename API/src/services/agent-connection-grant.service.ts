import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { asPrismaClient } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { assertAgentGrantEvidence, type AgentGrantEvidence } from './agent-connection-grant-evidence.service.js';
import {
  DAY_MS, RESOURCE_SCOPES, effectiveExpiry, evidenceOf, isFirstPartyAgentConnection, type Grant,
} from './agent-connection-grant-policy.service.js';
import { isAuthenticationEpochMismatchError, lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { consumeConfidentialAssertion } from './confidential-assertion-use.service.js';
import { resolveConfidentialDelegation } from './confidential-delegation.service.js';
import { verifyConfidentialSubjectToken } from './confidential-token-exchange.service.js';
import type { PublicRsaJwks } from './client-jwk.service.js';
import { getActiveClientOrgContext, type OrgContext } from './org-context.service.js';
import { signConfidentialAccessToken } from './oauth/access-token.service.js';
import { lockProductTeamPolicyShared, lockTokenIssuanceProductPolicy } from './product-team-policy-lock.service.js';
import { validateSessionAssurance } from './session-assurance.service.js';

/**
 * A program a person connected to a product, as one person in one organisation team.
 *
 * Issued only from that person's live session proof. Afterwards it lives on an idle clock that
 * only the program's own use moves (`touch`), optionally under the organisation's maximum
 * lifetime, and is rechecked on every renewal against the credential epoch, account, product
 * role, organisation and team membership, unpaid seats, the product mapping and the sign-in
 * evidence it was issued from. It is never a session proof: it carries no assurance id, cannot
 * satisfy account control, step-up, brokering or another grant's issue, and its resource tokens
 * carry only the scopes the product's mapping lists.
 */

export { FIRST_PARTY_AGENT_CONNECTIONS } from './agent-connection-grant-policy.service.js';

export const AGENT_GRANT_AUDIENCE_PATH = '/auth/agent-grants';
export const AGENT_GRANT_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
export const AGENT_GRANT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const AGENT_GRANT_RESOURCE_TOKEN_TTL_SECONDS = 120;

const Uuid = z.string().uuid();
const ConnectionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
const Product = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/u);
const Resource = z.string().url().max(2048);

type Config = { org_features?: { enabled?: boolean; groups_enabled?: boolean } };

function unavailable(): never {
  throw new AppError('FORBIDDEN', 403, 'AGENT_GRANT_UNAVAILABLE');
}

function invalidRequest(): never {
  throw new AppError('BAD_REQUEST', 400, 'AGENT_GRANT_REQUEST_INVALID');
}

function requestConflict(): never {
  throw new AppError('BAD_REQUEST', 409, 'AGENT_GRANT_REQUEST_CONFLICT');
}

function bindingHash(input: (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

function isRetryableTransactionConflict(error: unknown): boolean {
  const candidate = error as { code?: string; meta?: { code?: string } };
  return ['P2002', 'P2034'].includes(candidate.code ?? '')
    || (candidate.code === 'P2010' && candidate.meta?.code === '40001');
}

async function serializable<T>(db: PrismaClient, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isRetryableTransactionConflict(error)) throw error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
  throw new AppError('INTERNAL', 503, 'AGENT_GRANT_RETRY_EXHAUSTED');
}


/** The organisation's absolute ceiling, read live so lowering it applies to existing grants. */
async function maxExpiresAt(tx: Prisma.TransactionClient, orgId: string, createdAt: Date): Promise<Date | null> {
  const org = await tx.organisation.findUnique({ where: { id: orgId }, select: { agentConnectionMaxDays: true } });
  return org?.agentConnectionMaxDays ? new Date(createdAt.getTime() + org.agentConnectionMaxDays * DAY_MS) : null;
}


/** Live authority for one person in one team, standing in for a session only where evidence allows. */
async function currentAuthority(tx: Prisma.TransactionClient, args: {
  clientDomainId: string; sourceDomain: string; config: Config; product: string; resource: string;
  subjectId: string; orgId: string; teamId: string; tokenVersion: number;
  assuranceId?: string; agentGrant?: AgentGrantEvidence;
}): Promise<{ email: string; org: OrgContext }> {
  const prisma = asPrismaClient(tx);
  try {
    await lockAndAssertAuthenticationEpoch({ userId: args.subjectId, domain: args.sourceDomain,
      credentialEpoch: args.tokenVersion }, { prisma: tx });
  } catch (error) {
    if (isAuthenticationEpochMismatchError(error)) return unavailable();
    throw error;
  }
  await lockProductTeamPolicyShared(tx);
  await lockTokenIssuanceProductPolicy({ clientDomainId: args.clientDomainId, domain: args.sourceDomain }, { prisma });
  if (!isFirstPartyAgentConnection(args.product, args.sourceDomain, args.resource)) {
    await resolveConfidentialDelegation({ authenticatedClientDomainId: args.clientDomainId,
      sourceDomain: args.sourceDomain, product: args.product, resource: args.resource,
      scope: 'agent.connection', agentConnectionGrant: true }, { prisma });
  }
  if (args.agentGrant) await assertAgentGrantEvidence(args.agentGrant, prisma);
  const [user, domainRole, org] = await Promise.all([
    tx.user.findFirst({ where: { id: args.subjectId, lifecycleStatus: 'ACTIVE' }, select: { email: true } }),
    tx.domainRole.findUnique({ where: { domain_userId: { domain: args.sourceDomain, userId: args.subjectId } },
      select: { role: true } }),
    getActiveClientOrgContext({ userId: args.subjectId, domain: args.sourceDomain, orgId: args.orgId,
      groupsEnabled: args.config.org_features?.groups_enabled, assuranceId: args.assuranceId,
      agentGrant: args.agentGrant }, { crossProductPrisma: prisma, policyPrisma: prisma, prisma }),
  ]);
  if (!user?.email || !domainRole || !org || !org.teams.includes(args.teamId)) unavailable();
  return { email: user.email, org };
}

export async function issueAgentConnectionGrant(
  params: { clientDomainId: string; sourceDomain: string; configJwt: string; config: Config;
    requestId: string; connectionId: string; product: string; resource: string; subjectToken: string },
  deps: { prisma?: PrismaClient; now?: () => number;
    fetchJwks?: (jwksUrl: string, opts: { expectedHost: string }) => Promise<PublicRsaJwks> } = {},
): Promise<{ grantHandle: string; idleExpiresAt: string; expiresAt: string; created: boolean }> {
  if (!params.clientDomainId || !Uuid.safeParse(params.requestId).success
    || !ConnectionId.safeParse(params.connectionId).success || !Product.safeParse(params.product).success
    || !Resource.safeParse(params.resource).success) invalidRequest();
  const nowSeconds = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const assertion = await verifyConfidentialSubjectToken({
    subjectToken: params.subjectToken, configJwt: params.configJwt, sourceDomain: params.sourceDomain,
    audience: `${getPublicBaseUrl()}${AGENT_GRANT_AUDIENCE_PATH}`,
  }, { now: () => nowSeconds, fetchJwks: deps.fetchJwks });
  // A grant starts only from a person's live, proven sign-in in that exact team.
  if (!assertion.active || assertion.source_domain !== params.sourceDomain || !assertion.verifiedAssuranceId) {
    invalidRequest();
  }
  const active = assertion.active;
  const assuranceId = assertion.verifiedAssuranceId;
  const now = new Date(nowSeconds * 1000);
  const binding = bindingHash([params.clientDomainId, params.sourceDomain, params.requestId, params.connectionId,
    assertion.sub, active.orgId, active.teamId, assertion.tv, params.product, params.resource]);
  const db = deps.prisma ?? getAdminPrisma();
  const outcome = await serializable(db, async (tx) => {
    const existing = await tx.agentConnectionGrant.findUnique({ where: {
      clientDomainId_requestId: { clientDomainId: params.clientDomainId, requestId: params.requestId } } });
    if (existing && existing.bindingHash !== binding) requestConflict();
    const proof = await validateSessionAssurance({ id: assuranceId, userId: assertion.sub,
      credentialEpoch: assertion.tv, clientDomain: params.sourceDomain, orgId: active.orgId,
      teamId: active.teamId }, asPrismaClient(tx));
    if (proof.method !== 'independent' && proof.method !== 'sso') unavailable();
    await currentAuthority(tx, { clientDomainId: params.clientDomainId, sourceDomain: params.sourceDomain,
      config: params.config, product: params.product, resource: params.resource, subjectId: assertion.sub,
      orgId: active.orgId, teamId: active.teamId, tokenVersion: assertion.tv, assuranceId: proof.id });
    if (existing) {
      // Lost-response recovery: the same request returns the same handle while it is alive.
      const max = await maxExpiresAt(tx, existing.orgId, existing.createdAt);
      if (existing.revokedAt || effectiveExpiry(existing.idleExpiresAt, max) <= now) unavailable();
      return { row: existing, max, created: false };
    }
    await consumeConfidentialAssertion({ expiresAtEpochSeconds: assertion.exp, jti: assertion.jti,
      sourceDomain: params.sourceDomain }, { prisma: asPrismaClient(tx), now: () => now });
    const row = await tx.agentConnectionGrant.create({ data: {
      clientDomainId: params.clientDomainId, requestId: params.requestId, connectionId: params.connectionId,
      sourceDomain: params.sourceDomain, subjectId: assertion.sub, orgId: active.orgId, teamId: active.teamId,
      tokenVersion: assertion.tv, originTokenJti: assertion.jti, product: params.product,
      resource: params.resource, bindingHash: binding, sourceAssuranceId: proof.id, method: proof.method,
      connectionRef: proof.connectionId, connectionRevision: proof.connectionRevision,
      connectionGeneration: proof.connectionGeneration, externalIdentityId: proof.externalIdentityId,
      mfaSource: proof.mfaSource, amr: proof.amr, policyGeneration: proof.policyGeneration,
      idleExpiresAt: new Date(now.getTime() + AGENT_GRANT_IDLE_MS), lastTouchedAt: now, createdAt: now,
    } });
    return { row, max: await maxExpiresAt(tx, row.orgId, row.createdAt), created: true };
  });
  return { grantHandle: outcome.row.id, idleExpiresAt: outcome.row.idleExpiresAt.toISOString(),
    expiresAt: effectiveExpiry(outcome.row.idleExpiresAt, outcome.max).toISOString(), created: outcome.created };
}

async function lockGrant(tx: Prisma.TransactionClient, handle: string, caller: {
  clientDomainId: string; sourceDomain: string; requestId: string;
}): Promise<Grant> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_connection_grants WHERE id = ${handle} FOR UPDATE`);
  const row = await tx.agentConnectionGrant.findUnique({ where: { id: handle } });
  if (!row || row.clientDomainId !== caller.clientDomainId || row.sourceDomain !== caller.sourceDomain
    || row.requestId !== caller.requestId) unavailable();
  return row;
}

export type AgentGrantRenewal = {
  idleExpiresAt: string;
  expiresAt: string;
  org: OrgContext;
  resourceToken?: { accessToken: string; expiresIn: number; resource: string; scope: string };
};

export async function renewAgentConnectionGrant(
  params: { grantHandle: string; clientDomainId: string; sourceDomain: string; config: Config;
    requestId: string; touch: boolean; resource?: string; scope?: string },
  deps: { prisma?: PrismaClient; now?: Date } = {},
): Promise<AgentGrantRenewal> {
  if (!Uuid.safeParse(params.grantHandle).success || !Uuid.safeParse(params.requestId).success
    || (params.resource === undefined) !== (params.scope === undefined)
    || (params.resource !== undefined && !Resource.safeParse(params.resource).success)) invalidRequest();
  const scopes = params.scope?.trim().split(/\s+/u) ?? [];
  if (scopes.some((scope) => !RESOURCE_SCOPES.has(scope))) invalidRequest();
  const db = deps.prisma ?? getAdminPrisma();
  const now = deps.now ?? new Date();
  return serializable(db, async (tx) => {
    const row = await lockGrant(tx, params.grantHandle, params);
    const max = await maxExpiresAt(tx, row.orgId, row.createdAt);
    if (row.revokedAt || effectiveExpiry(row.idleExpiresAt, max) <= now) unavailable();
    const current = await currentAuthority(tx, { clientDomainId: row.clientDomainId, sourceDomain: row.sourceDomain,
      config: params.config, product: row.product, resource: row.resource, subjectId: row.subjectId,
      orgId: row.orgId, teamId: row.teamId, tokenVersion: row.tokenVersion, agentGrant: evidenceOf(row) });
    let idleExpiresAt = row.idleExpiresAt;
    // Only the program's own use keeps the grant alive; reconciliation and background work do not.
    if (params.touch && now.getTime() - row.lastTouchedAt.getTime() >= AGENT_GRANT_TOUCH_INTERVAL_MS) {
      idleExpiresAt = new Date(now.getTime() + AGENT_GRANT_IDLE_MS);
      await tx.agentConnectionGrant.update({ where: { id: row.id }, data: { idleExpiresAt, lastTouchedAt: now } });
    }
    const expiresAt = effectiveExpiry(idleExpiresAt, max);
    const renewal: AgentGrantRenewal = { idleExpiresAt: idleExpiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(), org: current.org };
    if (!params.resource || !params.scope) return renewal;
    const delegation = await resolveConfidentialDelegation({ authenticatedClientDomainId: row.clientDomainId,
      sourceDomain: row.sourceDomain, product: row.product, resource: params.resource, scope: params.scope },
    { prisma: asPrismaClient(tx) });
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const tokenExpiresAt = Math.min(Math.floor(expiresAt.getTime() / 1000),
      nowSeconds + AGENT_GRANT_RESOURCE_TOKEN_TTL_SECONDS);
    if (tokenExpiresAt <= nowSeconds) unavailable();
    const accessToken = await signConfidentialAccessToken({
      subject: row.subjectId, credentialEpoch: row.tokenVersion, email: current.email,
      sourceDomain: row.sourceDomain, product: delegation.product, resource: delegation.resource,
      issuer: getPublicBaseUrl(), ttlSeconds: AGENT_GRANT_RESOURCE_TOKEN_TTL_SECONDS,
      expiresAtEpochSeconds: tokenExpiresAt, scope: delegation.scope, org: current.org,
      active: { orgId: row.orgId, teamId: row.teamId },
      agentConnection: { grant_handle: row.id, connection_id: row.connectionId },
    });
    return { ...renewal, resourceToken: { accessToken, expiresIn: tokenExpiresAt - nowSeconds,
      resource: delegation.resource, scope: delegation.scope } };
  });
}

/** Idempotent; needs no current membership, so a product can always end what it holds. */
export async function revokeAgentConnectionGrant(
  params: { grantHandle: string; clientDomainId: string; sourceDomain: string; requestId: string },
  deps: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ revoked: true }> {
  if (!Uuid.safeParse(params.grantHandle).success || !Uuid.safeParse(params.requestId).success) invalidRequest();
  const db = deps.prisma ?? getAdminPrisma();
  const now = deps.now ?? new Date();
  await serializable(db, async (tx) => {
    const row = await lockGrant(tx, params.grantHandle, params);
    if (!row.revokedAt) await tx.agentConnectionGrant.update({ where: { id: row.id }, data: { revokedAt: now } });
  });
  return { revoked: true };
}

