import { PrismaClient } from '@prisma/client';

import { verifyCloudRunWebsiteContextReaderFloor } from '../services/website-context-reader-floor.js';
const args = process.argv.slice(2);
const apply = args[0] === '--apply-after-old-revisions-drained';
const option = (key: string) => args.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? '';
if ((!apply && (args.length !== 1 || args[0] !== '--dry-run')) ||
    (apply && args.some(value => !/^--(?:apply-after-old-revisions-drained|project=.+|region=.+|service=.+|compatible-image=sha256:[a-f0-9]{64})$/.test(value)))) {
  throw new Error('Use --dry-run, or --apply-after-old-revisions-drained with explicit --project, --region, --service and reviewed --compatible-image digests');
}
if (apply) {
  if (process.env.WEBSITE_CLIENT_CONTEXT_PHASE !== 'stable') throw new Error('Apply requires stable phase; bridge never converts stored context');
  verifyCloudRunWebsiteContextReaderFloor({ project: option('project'), region: option('region'), service: option('service'),
    approvedDigests: args.filter(value => value.startsWith('--compatible-image=')).map(value => value.slice('--compatible-image='.length)) });
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
try {
  const rows = await db.$queryRaw<Array<{ familyId: string; userId: string; domain: string; clientId: string; configUrl: string }>>`
    SELECT DISTINCT family_id AS "familyId", user_id AS "userId", domain,
      client_id AS "clientId", config_url AS "configUrl"
    FROM refresh_tokens WHERE client_id ~ '^[a-fA-F0-9]{64}$'
    ORDER BY family_id, client_id
  `;
  let migrated = 0, retired = 0;
  for (const row of rows) {
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
