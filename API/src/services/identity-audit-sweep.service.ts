import { Prisma, type PrismaClient } from '@prisma/client';

/** Match identity-bearing fields, never substrings of names or arbitrary action text. */
export function scrubIdentityJson(value: Prisma.JsonValue, terms: string[], eraseId?: string): Prisma.InputJsonValue {
  const [email, name, userKey] = terms;
  const scrub = (item: Prisma.JsonValue, key = ''): Prisma.JsonValue => {
    if (typeof item === 'string') {
      if (eraseId && item === eraseId) return null;
      if (userKey && item === userKey) return null;
      if (email && item.toLowerCase() === email.toLowerCase()) return null;
      if (name && /name/i.test(key) && item === name) return 'Deleted user';
      if (email) {
        const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return item.replace(new RegExp(`(?<![\\w.+-])${escaped}(?![\\w.-])`, 'gi'), '[deleted]');
      }
      return item;
    }
    if (Array.isArray(item)) return item.map(child => scrub(child, key));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v === undefined ? null : scrub(v, k)]));
    return item;
  };
  return scrub(value) as Prisma.InputJsonValue;
}

export async function scrubOperationalAudits(tx: PrismaClient, user: { id: string; email: string | null; name: string | null; userKey: string | null }, erase: boolean) {
  const terms = [user.email ?? '', user.name ?? '', user.userKey ?? ''];
  // Cursor batches bound memory; SQL first selects records containing this identity, not every audit.
  for (const table of ['org_audit_log', 'admin_audit_log', 'handshake_error_logs'] as const) {
    let cursor = '';
    while (true) {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM ${Prisma.raw(table)} WHERE id > ${cursor}
        AND (to_jsonb(${Prisma.raw(table)})::text LIKE ${`%${user.id}%`}
          OR (${user.email !== null} AND lower(to_jsonb(${Prisma.raw(table)})::text) LIKE ${`%${(user.email ?? '').toLowerCase().replaceAll('%', '\\%').replaceAll('_', '\\_')}%`}))
        ORDER BY id LIMIT 100`);
      if (!rows.length) break;
      for (const row of rows) {
        if (table === 'org_audit_log') {
          const audit = await tx.orgAuditLog.findUniqueOrThrow({ where: { id: row.id } });
          await tx.orgAuditLog.update({ where: { id: row.id }, data: {
            metadata: scrubIdentityJson(audit.metadata, terms, erase ? user.id : undefined),
            ...(erase && audit.actorUserId === user.id ? { actorUserId: null } : {}),
            ...(erase && audit.targetId === user.id ? { targetId: 'Deleted user' } : {}),
          } });
        } else if (table === 'admin_audit_log') {
          const audit = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: row.id } });
          await tx.adminAuditLog.update({ where: { id: row.id }, data: {
            metadata: scrubIdentityJson(audit.metadata, terms, erase ? user.id : undefined),
            ...(audit.actorEmail.toLowerCase() === user.email?.toLowerCase() ? { actorEmail: 'Deleted user' } : {}),
          } });
        } else {
          // Handshake diagnostics are operational; IP/user-agent copies have no historical purpose.
          await tx.handshakeErrorLog.delete({ where: { id: row.id } });
        }
      }
      cursor = rows[rows.length - 1].id;
    }
  }
}
