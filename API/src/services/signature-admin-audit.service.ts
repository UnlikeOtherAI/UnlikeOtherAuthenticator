import type { Prisma, PrismaClient } from '@prisma/client';

import { writeAuditLog, type AdminAuditAction } from './audit-log.service.js';

export type SignatureAdminAuditPrisma = Pick<PrismaClient, 'signatureAuditEvent' | 'adminAuditLog'>;

export async function writeSignatureAdminAudit(
  params: {
    domain: string;
    actorEmail: string;
    action: Extract<AdminAuditAction, `signature.${string}`>;
    targetType: 'settings' | 'agreement' | 'agreement_version' | 'signature';
    targetId: string;
    metadata?: Prisma.InputJsonValue;
  },
  deps: { prisma: SignatureAdminAuditPrisma },
): Promise<void> {
  await deps.prisma.signatureAuditEvent.create({
    data: {
      domain: params.domain,
      actorEmail: params.actorEmail,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: params.metadata ?? {},
    },
  });
  await writeAuditLog(
    {
      actorEmail: params.actorEmail,
      action: params.action,
      targetDomain: params.domain,
      metadata: {
        target_type: params.targetType,
        target_id: params.targetId,
        ...(params.metadata && !Array.isArray(params.metadata) && typeof params.metadata === 'object'
          ? params.metadata
          : {}),
      },
    },
    { prisma: deps.prisma },
  );
}
