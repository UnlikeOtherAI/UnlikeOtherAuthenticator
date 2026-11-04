import { PrismaClient } from '@prisma/client';

import { createTestDb } from './test-db.js';

/** Apply the zone to every pooled connection, including concurrent claims. */
export async function createBillingTimezoneDb(timeZone: string) {
  const db = await createTestDb();
  if (!db) throw new Error('DATABASE_URL_REQUIRED');
  const url = new URL(db.databaseUrl);
  url.searchParams.set('options', `-c TimeZone=${timeZone}`);
  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const cleanup = async () => { await prisma.$disconnect(); await db.cleanup(); };
  try {
    const rows = await prisma.$queryRaw<Array<{ TimeZone: string }>>`SHOW TimeZone`;
    if (rows[0]?.TimeZone !== timeZone) throw new Error('TEST_DATABASE_TIMEZONE_MISMATCH');
    return { ...db, databaseUrl: url.toString(), prisma, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
