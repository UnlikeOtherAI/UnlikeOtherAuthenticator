import type { HandshakeErrorLog, Prisma, PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';

type HandshakeErrorPrisma = {
  handshakeErrorLog: Pick<PrismaClient['handshakeErrorLog'], 'create' | 'findMany'>;
};

export type HandshakeErrorPhase =
  | 'config_fetch'
  | 'config_domain'
  | 'jwt_verify'
  | 'startup'
  | 'token_exchange';

export type HandshakeErrorRecord = {
  id: string;
  ts: string;
  app: string;
  appId: string;
  domain: string;
  organisation: string;
  endpoint: string;
  phase: HandshakeErrorPhase;
  statusCode: number;
  errorCode: string;
  summary: string;
  details: string[];
  missingClaims: string[];
  ip: string;
  userAgent: string;
  requestId: string;
  requestJson: Record<string, unknown>;
  responseJson: Record<string, unknown>;
  jwtHeader: Record<string, unknown>;
  jwtPayload: Record<string, unknown>;
  redactions: string[];
};

export type RecordHandshakeErrorParams = {
  app?: string | null;
  appId?: string | null;
  domain: string;
  organisation?: string | null;
  endpoint: string;
  phase: HandshakeErrorPhase;
  statusCode: number;
  errorCode: string;
  summary: string;
  details?: string[];
  missingClaims?: string[];
  ip?: string | null;
  userAgent?: string | null;
  requestId: string;
  requestJson?: Record<string, unknown>;
  responseJson?: Record<string, unknown>;
  jwtHeader?: Record<string, unknown>;
  jwtPayload?: Record<string, unknown>;
  redactions?: string[];
};

type HandshakeErrorDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: HandshakeErrorPrisma;
};

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function jsonArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toRecord(row: HandshakeErrorLog): HandshakeErrorRecord {
  return {
    id: row.id,
    ts: row.createdAt.toISOString().replace('T', ' ').slice(0, 19),
    app: row.app ?? row.domain,
    appId: row.appId ?? '',
    domain: row.domain,
    organisation: row.organisation ?? '',
    endpoint: row.endpoint,
    phase: row.phase as HandshakeErrorPhase,
    statusCode: row.statusCode,
    errorCode: row.errorCode,
    summary: row.summary,
    details: jsonArray(row.details),
    missingClaims: jsonArray(row.missingClaims),
    ip: row.ip ?? '',
    userAgent: row.userAgent ?? '',
    requestId: row.requestId,
    requestJson: jsonObject(row.requestJson),
    responseJson: jsonObject(row.responseJson),
    jwtHeader: jsonObject(row.jwtHeader),
    jwtPayload: jsonObject(row.jwtPayload),
    redactions: jsonArray(row.redactions),
  };
}

export async function listHandshakeErrorLogs(
  params: { limit?: number } = {},
  deps?: HandshakeErrorDeps,
): Promise<HandshakeErrorRecord[]> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return [];

  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as HandshakeErrorPrisma);
  const limit = Math.max(1, Math.min(500, params.limit ?? 100));
  const rows = await prisma.handshakeErrorLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return rows.map(toRecord);
}

export async function recordHandshakeErrorLog(
  params: RecordHandshakeErrorParams,
  deps?: HandshakeErrorDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return;

  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as HandshakeErrorPrisma);
  await prisma.handshakeErrorLog.create({
    data: {
      app: params.app ?? null,
      appId: params.appId ?? null,
      domain: normalizeDomain(params.domain),
      organisation: params.organisation ?? null,
      endpoint: params.endpoint,
      phase: params.phase,
      statusCode: params.statusCode,
      errorCode: params.errorCode,
      summary: params.summary,
      details: params.details ?? [],
      missingClaims: params.missingClaims ?? [],
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      requestId: params.requestId,
      requestJson: (params.requestJson ?? {}) as Prisma.InputJsonValue,
      responseJson: (params.responseJson ?? {}) as Prisma.InputJsonValue,
      jwtHeader: (params.jwtHeader ?? {}) as Prisma.InputJsonValue,
      jwtPayload: (params.jwtPayload ?? {}) as Prisma.InputJsonValue,
      redactions: params.redactions ?? [],
    },
    select: { id: true },
  });
}
