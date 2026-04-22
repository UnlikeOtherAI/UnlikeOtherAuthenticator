import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';

export type AdminAuditAction =
  | 'integration.accepted'
  | 'integration.declined'
  | 'integration.deleted'
  | 'integration.claim_resent'
  | 'jwk.added'
  | 'jwk.deactivated'
  | 'domain.disabled'
  | 'domain.enabled'
  | 'domain.secret_rotated';

export type AuditLogPrisma = Pick<PrismaClient, 'adminAuditLog'>;

function prismaClient(deps?: { prisma?: AuditLogPrisma }): AuditLogPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as AuditLogPrisma);
}

export async function writeAuditLog(
  params: {
    actorEmail: string;
    action: AdminAuditAction;
    targetDomain?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
  deps?: { prisma?: AuditLogPrisma },
): Promise<void> {
  await prismaClient(deps).adminAuditLog.create({
    data: {
      actorEmail: params.actorEmail,
      action: params.action,
      targetDomain: params.targetDomain ?? null,
      metadata: params.metadata ?? {},
    },
  });
}
