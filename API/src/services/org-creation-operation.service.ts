import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { AppError } from '../utils/errors.js';
import { lockOrganisationMemberships } from './organisation-membership-lock.service.js';
import { getOrganisationMember, toOrganisationRecord } from './organisation.service.base.js';
import { requireTeamCapability, toTeamRecord } from './team.service.base.js';

export type OrgCreationScope = {
  clientDomainId: string;
  domain: string;
  actorUserId: string | null;
  operation: 'organisation' | 'team';
  parentId: string | null;
};

export const orgCreationRecovery = {
  capability: 'org_creation_recovery_v1',
  version: 1,
  key_header: 'Idempotency-Key',
  registration_header: 'X-UOA-Creation-Registration',
  contract: '/org/creation-contract',
  organisation_status: '/org/organisations/creation-status',
  team_status: '/org/organisations/:orgId/teams/creation-status',
  retention: 'permanent receipt; deletion never permits key reuse',
} as const;

export function parseCreationKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{16,200}$/.test(value)) {
    throw new AppError('BAD_REQUEST', 400, 'CREATION_KEY_INVALID');
  }
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function operationId(scope: OrgCreationScope, key: string): string {
  return hash([1, scope.clientDomainId, scope.domain, scope.actorUserId,
    scope.operation, scope.parentId, key]);
}

async function lockOperation(tx: PrismaClient, id: string): Promise<void> {
  // The caller already holds live request authority in its tenant transaction.
  // A concurrent reader waits for the original commit/rollback before answering.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`org-create:${id}`}, 0))`;
}

export async function readCreatedResource(
  tx: PrismaClient,
  scope: OrgCreationScope,
  ids: { resultOrgId: string; resultTeamId: string },
  config: ClientConfig,
) {
  let org = await tx.organisation.findFirst({
    where: { id: ids.resultOrgId, lifecycleStatus: 'ACTIVE' },
  });
  if (!org || (!scope.actorUserId && org.domain !== scope.domain)) {
    throw new AppError('NOT_FOUND', 404, 'CREATION_RESULT_UNAVAILABLE');
  }
  if (scope.actorUserId && !await getOrganisationMember(tx,
    { orgId: org.id, userId: scope.actorUserId }, { activeOnly: true })) {
    throw new AppError('FORBIDDEN', 403);
  }
  // The receipt is the only source of the IDs; current access is still checked.
  // Establish the checked container for RLS before locking it, then re-read all
  // mutable authority and result data while holding the canonical locks.
  await tx.$executeRaw`SELECT set_config('app.org_id', ${org.id}, true)`;
  await lockOrganisationMemberships(tx, org.id, scope.actorUserId ? [scope.actorUserId] : []);
  org = await tx.organisation.findFirst({ where: { id: ids.resultOrgId, lifecycleStatus: 'ACTIVE' } });
  if (!org || (!scope.actorUserId && org.domain !== scope.domain)) {
    throw new AppError('NOT_FOUND', 404, 'CREATION_RESULT_UNAVAILABLE');
  }
  if (scope.actorUserId && !await getOrganisationMember(tx,
    { orgId: org.id, userId: scope.actorUserId }, { activeOnly: true })) {
    throw new AppError('FORBIDDEN', 403);
  }
  if (scope.operation === 'team') {
    if (scope.parentId !== org.id) throw new AppError('INTERNAL', 500);
    await requireTeamCapability(tx, 'teams.manage', {
      orgId: org.id, actorUserId: scope.actorUserId ?? undefined, config,
    });
  }
  const team = await tx.team.findFirst({
    where: { id: ids.resultTeamId, orgId: org.id, lifecycleStatus: 'ACTIVE' },
  });
  if (!team) throw new AppError('NOT_FOUND', 404, 'CREATION_RESULT_UNAVAILABLE');
  return { organisation: toOrganisationRecord(org), team: toTeamRecord(team, org.domain) };
}

/** Must run inside the request's existing authority/tenant transaction. */
export async function runOrgCreation<T>(
  tx: PrismaClient,
  input: { scope: OrgCreationScope; key: string; request: readonly unknown[] },
  create: () => Promise<T>,
  resultIds: (result: T) => { resultOrgId: string; resultTeamId: string },
  replay: (ids: { resultOrgId: string; resultTeamId: string }) => Promise<T>,
): Promise<T> {
  const id = operationId(input.scope, input.key);
  await lockOperation(tx, id);
  const requestHash = hash([1, ...input.request]);
  const existing = await tx.orgCreationOperation.findUnique({ where: { id } });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AppError('BAD_REQUEST', 409, 'CREATION_KEY_CONFLICT');
    }
    return replay(existing);
  }
  const result = await create();
  await tx.orgCreationOperation.create({ data: {
    id, ...input.scope, requestHash, ...resultIds(result),
  } });
  return result;
}

export async function readOrgCreationStatus(
  tx: PrismaClient,
  scope: OrgCreationScope,
  key: string,
  config: ClientConfig,
) {
  const id = operationId(scope, key);
  await lockOperation(tx, id);
  const receipt = await tx.orgCreationOperation.findUnique({ where: { id } });
  if (!receipt) throw new AppError('NOT_FOUND', 404, 'CREATION_OPERATION_NOT_FOUND');
  await readCreatedResource(tx, scope, receipt, config);
  return { status: 'committed' as const, organisationId: receipt.resultOrgId, teamId: receipt.resultTeamId };
}
