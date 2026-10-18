import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

export const EnterpriseRevocationCapabilities = z.object({ version: z.literal(1), feed: z.literal(true),
  reconciliation: z.literal(true), use_time_assurance: z.literal(true), immutable_custody: z.literal(true) }).strict();
type Db = Pick<PrismaClient | Prisma.TransactionClient, 'orgRevocationConsumer'>;
export async function enterpriseRevocationReady(clientDomain: string, db: Db): Promise<boolean> {
  const consumer = await db.orgRevocationConsumer.findUnique({ where: { clientDomain },
    select: { enabled: true, acknowledgedAt: true, capabilityVersion: true } });
  return Boolean(consumer?.enabled && consumer.acknowledgedAt && consumer.capabilityVersion === 1);
}
