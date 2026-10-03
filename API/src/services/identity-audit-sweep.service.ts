import { Prisma, type PrismaClient } from '@prisma/client';

/** Match identity-bearing fields, never substrings of names or arbitrary action text. */
export function scrubIdentityJson(value: Prisma.JsonValue, terms: string[], eraseId?: string, identityContext = false, identityId = eraseId): Prisma.InputJsonValue {
  const [email, name, userKey] = terms;
  const scrub = (item: Prisma.JsonValue, key = '', ownIdentity = identityContext): Prisma.JsonValue => {
    if (ownIdentity && /^(ip|userAgent|avatarUrl|phone|address|providerUserId|providerAccountId|externalId)$/i.test(key)) return null;
    if (typeof item === 'string') {
      if (eraseId && item === eraseId) return null;
      if (userKey && item === userKey) return null;
      if (email && item.toLowerCase() === email.toLowerCase()) return null;
      if (ownIdentity && /(?:^name$|Name$)/.test(key) && name && item === name) return 'Deleted user';
      if (email) {
        const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return item.replace(new RegExp(`(?<![\\w.+-])${escaped}(?![\\w.-])`, 'gi'), '[deleted]');
      }
      return item;
    }
    if (Array.isArray(item)) return item.map(child => scrub(child, key, ownIdentity));
    if (item && typeof item === 'object') {
      const entries = Object.entries(item);
      const differentIdentity = entries.some(([k, v]) => typeof v === 'string' && ((/^(userId|subjectId)$/i.test(k) && identityId && v !== identityId) || (/^email$/i.test(k) && email && v.toLowerCase() !== email.toLowerCase())));
      const bound = !differentIdentity && (ownIdentity || entries.some(([k, v]) => typeof v === 'string' && ((/^(userId|subjectId|id)$/i.test(k) && v === identityId) || (/email$/i.test(k) && email && v.toLowerCase() === email.toLowerCase()))));
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v === undefined ? null : scrub(v, k, bound)]));
    }
    return item;
  };
  return scrub(value) as Prisma.InputJsonValue;
}

export async function scrubOperationalAuditsBatch(tx: PrismaClient, user: { id: string; email: string | null; name: string | null; userKey: string | null }, erase: boolean, progress: AuditProgress = { tableIndex: 0, cursor: '', complete: false }) {
  const terms = [user.email ?? '', user.name ?? '', user.userKey ?? ''];
  // Cursor batches bound memory; SQL first selects records containing this identity, not every audit.
  const table = auditTables[progress.tableIndex];
  if (!table) return { ...progress, complete: true };
  const cursor = progress.cursor;
  {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM ${Prisma.raw(table)} WHERE id > ${cursor}
        AND ${table !== 'entity_deletion_jobs' ? Prisma.sql`true` : Prisma.sql`status='COMPLETE'`}
        AND (to_jsonb(${Prisma.raw(table)})::text LIKE ${`%${user.id}%`}
          OR (${user.email !== null} AND lower(to_jsonb(${Prisma.raw(table)})::text) LIKE ${`%${(user.email ?? '').toLowerCase().replaceAll('%', '\\%').replaceAll('_', '\\_')}%`}))
        ORDER BY id LIMIT 100`);
      if (!rows.length) return { tableIndex: progress.tableIndex + 1, cursor: '', complete: progress.tableIndex + 1 >= auditTables.length };
      for (const row of rows) {
        if (table === 'org_audit_log') {
          const audit = await tx.orgAuditLog.findUniqueOrThrow({ where: { id: row.id } });
          await tx.orgAuditLog.update({ where: { id: row.id }, data: {
            metadata: scrubIdentityJson(audit.metadata, terms, erase ? user.id : undefined, audit.actorUserId === user.id || audit.targetId === user.id, user.id),
            ...(erase && audit.actorUserId === user.id ? { actorUserId: null } : {}),
            ...(erase && audit.targetId === user.id ? { targetId: 'Deleted user' } : {}),
          } });
        } else if (table === 'admin_audit_log') {
          const audit = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: row.id } });
          await tx.adminAuditLog.update({ where: { id: row.id }, data: {
            metadata: scrubIdentityJson(audit.metadata, terms, erase ? user.id : undefined, audit.actorEmail.toLowerCase() === user.email?.toLowerCase(), user.id),
            ...(audit.actorEmail.toLowerCase() === user.email?.toLowerCase() ? { actorEmail: 'Deleted user' } : {}),
          } });
        } else if (table === 'entity_deletion_jobs') {
          const job = await tx.entityDeletionJob.findUniqueOrThrow({ where: { id: row.id } });
          await tx.entityDeletionJob.update({ where: { id: row.id }, data: {
            preview: scrubIdentityJson(job.preview, terms, erase ? user.id : undefined, false, user.id),
          } });
        } else {
          // Handshake diagnostics are operational; IP/user-agent copies have no historical purpose.
          await tx.handshakeErrorLog.delete({ where: { id: row.id } });
        }
      }
      return { tableIndex: progress.tableIndex, cursor: rows[rows.length - 1].id, complete: false };
  }
}

export type AuditProgress = { tableIndex: number; cursor: string; complete: boolean };
const auditTables = ['org_audit_log', 'admin_audit_log', 'handshake_error_logs', 'entity_deletion_jobs'] as const;
export async function scrubOperationalAudits(tx: PrismaClient, user: { id: string; email: string | null; name: string | null; userKey: string | null }, erase: boolean) {
  let progress: AuditProgress = { tableIndex: 0, cursor: '', complete: false };
  while (!progress.complete) progress = await scrubOperationalAuditsBatch(tx, user, erase, progress);
}
