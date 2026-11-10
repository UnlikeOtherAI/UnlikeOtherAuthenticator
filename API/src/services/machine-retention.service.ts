import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';

/** Only expired browser transport is ephemeral. Consent, operation and event history stay immutable. */
export async function pruneMachineBrowsers(db: PrismaClient = getAdminPrisma(), now = new Date()): Promise<void> {
  await db.machineBrowserSession.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
}
