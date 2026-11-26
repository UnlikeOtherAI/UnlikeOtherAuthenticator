import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { asPrismaClient } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { assertAgentGrantEvidence, type AgentGrantEvidence } from './agent-connection-grant-evidence.service.js';
import { getActiveClientOrgContext } from './org-context.service.js';
import { resolveConfidentialDelegation } from './confidential-delegation.service.js';

/** Rules shared by the grant service and the subject-assertion verifier. */

export const DAY_MS = 24 * 60 * 60 * 1000;
const Uuid = z.string().uuid();

/** Scopes a grant may mint for a downstream resource. Never `agent.connection`, brokering or provisioning. */
export const RESOURCE_SCOPES: ReadonlySet<string> = new Set(['ai.invoke', 'billing.read', 'memory.read', 'memory.write']);

export type Grant = NonNullable<Awaited<ReturnType<PrismaClient['agentConnectionGrant']['findUnique']>>>;

/**
 * First-party products that hold agent connection grants without an operator mapping: on from the
 * start, at exactly this source domain and resource. Any other product needs an enabled
 * `agent.connection` mapping.
 */
export const FIRST_PARTY_AGENT_CONNECTIONS: Readonly<Record<string, { sourceDomain: string; resource: string }>> = {
  nessie: { sourceDomain: 'api.nessie.works', resource: 'https://api.nessie.works/mcp' },
};

export const isFirstPartyAgentConnection = (product: string, sourceDomain: string, resource: string): boolean => {
  const binding = FIRST_PARTY_AGENT_CONNECTIONS[product];
  return Boolean(binding && binding.sourceDomain === sourceDomain && binding.resource === resource);
};


export const effectiveExpiry = (idle: Date, max: Date | null): Date =>
  max && max.getTime() < idle.getTime() ? max : idle;

export const evidenceOf = (row: Grant): AgentGrantEvidence => ({
  subjectId: row.subjectId, sourceDomain: row.sourceDomain, orgId: row.orgId, method: row.method,
  connectionRef: row.connectionRef, connectionRevision: row.connectionRevision,
  connectionGeneration: row.connectionGeneration, externalIdentityId: row.externalIdentityId,
  mfaSource: row.mfaSource, amr: row.amr, policyGeneration: row.policyGeneration,
});

function unavailable(): never {
  throw new AppError('FORBIDDEN', 403, 'AGENT_GRANT_UNAVAILABLE');
}

export type AdmittedAgentGrant = { id: string; connectionId: string; expiresAt: Date; evidence: AgentGrantEvidence };

/**
 * A product's subject assertion that names an agent grant instead of a session proof
 * (`agent_grant`). Admitted only where the caller opts in (token exchange for ordinary
 * downstream scopes, organisation reads); it never touches the idle clock and never yields a
 * session assurance id.
 */
export async function admitAgentGrantAssertion(
  input: { handle: string; sourceDomain: string; subjectId: string; orgId: string; teamId: string;
    tokenVersion: number },
  db: PrismaClient | Prisma.TransactionClient,
  now = new Date(),
): Promise<AdmittedAgentGrant> {
  if (!Uuid.safeParse(input.handle).success) unavailable();
  const row = await db.agentConnectionGrant.findUnique({ where: { id: input.handle } });
  if (!row || row.revokedAt || row.sourceDomain !== input.sourceDomain || row.subjectId !== input.subjectId
    || (!row.allTeams && (row.orgId !== input.orgId || row.teamId !== input.teamId)) || row.tokenVersion !== input.tokenVersion) {
    unavailable();
  }
  const org = await db.organisation.findUnique({ where: { id: row.orgId }, select: { agentConnectionMaxDays: true } });
  const max = org?.agentConnectionMaxDays ? new Date(row.createdAt.getTime() + org.agentConnectionMaxDays * DAY_MS) : null;
  let expiresAt = effectiveExpiry(row.idleExpiresAt, max);
  if (expiresAt <= now) unavailable();
  const user = await db.user.findFirst({ where: { id: row.subjectId, lifecycleStatus: 'ACTIVE' },
    select: { tokenVersion: true } });
  if (!user || user.tokenVersion !== row.tokenVersion) unavailable();
  const prisma = asPrismaClient(db as Prisma.TransactionClient);
  if (!isFirstPartyAgentConnection(row.product, row.sourceDomain, row.resource)) {
    await resolveConfidentialDelegation({ authenticatedClientDomainId: row.clientDomainId,
      sourceDomain: row.sourceDomain, product: row.product, resource: row.resource,
      scope: 'agent.connection', agentConnectionGrant: true }, { prisma });
  }
  const evidence = evidenceOf(row);
  await assertAgentGrantEvidence(evidence, prisma);
  if (row.allTeams) {
    const ctx = await getActiveClientOrgContext({ userId: row.subjectId, domain: row.sourceDomain,
      orgId: input.orgId, agentGrant: evidence }, { prisma, crossProductPrisma: prisma, policyPrisma: prisma });
    if (!ctx?.teams.includes(input.teamId)) unavailable();
    const policy = await db.organisation.findUnique({ where: { id: input.orgId }, select: { agentConnectionMaxDays: true } });
    if (policy?.agentConnectionMaxDays) expiresAt = effectiveExpiry(expiresAt, new Date(row.createdAt.getTime() + policy.agentConnectionMaxDays * DAY_MS));
    if (expiresAt <= now) unavailable();
  }
  return { id: row.id, connectionId: row.connectionId, expiresAt, evidence };
}

/** Scopes a grant-derived token exchange may mint. */
export const isAgentGrantResourceScope = (scope: string): boolean =>
  scope.trim().split(/\s+/u).every((part) => RESOURCE_SCOPES.has(part));
