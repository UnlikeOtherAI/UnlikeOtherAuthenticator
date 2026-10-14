import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--dry-run', '--apply-after-old-revisions-drained'].includes(args[0])) {
  throw new Error('Use --dry-run or --apply-after-old-revisions-drained');
}
if (!process.env.DATABASE_ADMIN_URL || !process.env.SHARED_SECRET) {
  throw new Error('DATABASE_ADMIN_URL and SHARED_SECRET required');
}
// This dedicated operator process needs bootstrap authority, never the API runtime role.
process.env.DATABASE_URL = process.env.DATABASE_ADMIN_URL;
const { verifyDomainAuthToken } = await import('../services/domain-secret.service.js');
const { lockProductTeamPolicyShared } = await import('../services/product-team-policy-lock.service.js');
const { lockRefreshSessionUserDomain } = await import('../services/refresh-session-lock.service.js');
const { migrateWebsiteRefreshFamily } = await import('../services/website-client-context.service.js');
const { isAppError } = await import('../utils/errors.js');
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const apply = args[0] !== '--dry-run';
try {
  const rows = await db.refreshToken.findMany({ distinct: ['familyId'],
    where: { clientId: { not: { startsWith: 'retired:' } } },
    select: { familyId: true, userId: true, domain: true, clientId: true, configUrl: true },
  });
  let migrated = 0, retired = 0;
  for (const row of rows.filter(row => /^[a-f0-9]{64}$/i.test(row.clientId))) {
    await db.$transaction(async transaction => {
      const tx = transaction as unknown as PrismaClient;
      await lockProductTeamPolicyShared(tx);
      await lockRefreshSessionUserDomain(row, { prisma: tx });
      let clientId: string | null = null;
      try { clientId = (await verifyDomainAuthToken({ domain: row.domain, token: row.clientId }, { prisma: tx })).clientId; }
      catch (error) { if (!isAppError(error) || error.statusCode !== 401) throw error; }
      if (clientId) {
        if (apply) await migrateWebsiteRefreshFamily(row, { ...row, clientId }, tx);
        migrated += 1;
      } else {
        // A credential revoked before cutover must never regain a usable session.
        if (apply) {
          const now = new Date();
          await tx.refreshToken.updateMany({ where: { familyId: row.familyId },
            data: { clientId: 'retired:' + row.familyId, revokedAt: now } });
          await tx.debugLoginGrant.updateMany({ where: { sourceFamilyId: row.familyId },
            data: { clientId: 'retired:' + row.familyId, usedAt: now } });
        }
        retired += 1;
      }
    });
  }
  // Orphaned/expired debug grants cannot authorize a session; erase their old binding.
  if (apply) await db.$executeRaw`UPDATE debug_login_grants SET client_id = 'retired:' || id,
    used_at = COALESCE(used_at, now()) WHERE client_id ~ '^[a-fA-F0-9]{64}$'`;
  console.log(JSON.stringify({ apply, migrated_families: migrated, retired_families: retired }));
} finally { await db.$disconnect(); }
