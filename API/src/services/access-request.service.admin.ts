import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import {
  type AccessRequestPrisma,
  assertConfiguredAccessTarget,
  getEnv,
  normalizeAccessRequestStatus,
  toAccessRequestRecord,
  ensureUserAssignedToConfiguredAccessTarget,
  assertDatabaseEnabled,
} from './access-request.service.base.js';
import { AppError } from '../utils/errors.js';

type AccessRequestAdminDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: AccessRequestPrisma;
  now?: () => Date;
};

export async function listAccessRequests(params: {
  orgId: string;
  teamId: string;
  config: ClientConfig;
  status?: string;
}, deps?: AccessRequestAdminDeps): Promise<{ data: ReturnType<typeof toAccessRequestRecord>[] }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertConfiguredAccessTarget({
    config: params.config,
    orgId: params.orgId,
    teamId: params.teamId,
  });

  const prisma = deps?.prisma ?? (getPrisma() as AccessRequestPrisma);
  const status = normalizeAccessRequestStatus(params.status);
  const rows = await prisma.accessRequest.findMany({
    where: {
      orgId: params.orgId,
      teamId: params.teamId,
      status,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });

  return { data: rows.map(toAccessRequestRecord) };
}

async function findRequestOrThrow(params: {
  prisma: AccessRequestPrisma;
  requestId: string;
  orgId: string;
  teamId: string;
}) {
  const row = await params.prisma.accessRequest.findFirst({
    where: {
      id: params.requestId,
      orgId: params.orgId,
      teamId: params.teamId,
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });
  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}

export async function approveAccessRequest(params: {
  orgId: string;
  teamId: string;
  requestId: string;
  config: ClientConfig;
  reviewedByUserId?: string;
  reviewReason?: string;
}, deps?: AccessRequestAdminDeps): Promise<ReturnType<typeof toAccessRequestRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertConfiguredAccessTarget({
    config: params.config,
    orgId: params.orgId,
    teamId: params.teamId,
  });

  const prisma = deps?.prisma ?? (getPrisma() as AccessRequestPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const row = await findRequestOrThrow({
    prisma,
    requestId: params.requestId,
    orgId: params.orgId,
    teamId: params.teamId,
  });
  if (row.status === 'APPROVED') {
    return toAccessRequestRecord(row);
  }

  if (row.userId) {
    await ensureUserAssignedToConfiguredAccessTarget({
      prisma,
      config: params.config,
      userId: row.userId,
      now,
    });
  }

  const updated = await prisma.accessRequest.update({
    where: { id: row.id },
    data: {
      status: 'APPROVED',
      reviewedAt: now,
      reviewedByUserId: params.reviewedByUserId?.trim() || null,
      reviewReason: params.reviewReason?.trim() || null,
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });

  return toAccessRequestRecord(updated);
}

export async function rejectAccessRequest(params: {
  orgId: string;
  teamId: string;
  requestId: string;
  config: ClientConfig;
  reviewedByUserId?: string;
  reviewReason?: string;
}, deps?: AccessRequestAdminDeps): Promise<ReturnType<typeof toAccessRequestRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  assertConfiguredAccessTarget({
    config: params.config,
    orgId: params.orgId,
    teamId: params.teamId,
  });

  const prisma = deps?.prisma ?? (getPrisma() as AccessRequestPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const row = await findRequestOrThrow({
    prisma,
    requestId: params.requestId,
    orgId: params.orgId,
    teamId: params.teamId,
  });

  const updated = await prisma.accessRequest.update({
    where: { id: row.id },
    data: {
      status: 'REJECTED',
      reviewedAt: now,
      reviewedByUserId: params.reviewedByUserId?.trim() || null,
      reviewReason: params.reviewReason?.trim() || null,
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });

  return toAccessRequestRecord(updated);
}
