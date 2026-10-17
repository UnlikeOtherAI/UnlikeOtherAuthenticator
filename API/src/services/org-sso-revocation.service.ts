import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma, OrgRevocationEvent } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export type RevocationScope = 'user' | 'organisation' | 'product_org' | 'team' | 'connection';
export type RevocationInput = { clientDomain: string; scope: RevocationScope; revision: number;
  orgId?: string; teamId?: string; userId?: string; connectionId?: string };

/** Authority mutation and this operation MUST share a transaction and enterprise scope lock. */
export async function revokeEnterpriseScope(input: RevocationInput, tx: Prisma.TransactionClient) {
  if (!input.orgId && input.scope !== 'user') throw new AppError('BAD_REQUEST', 400, 'REVOCATION_SCOPE_REQUIRED');
  if (input.scope === 'user' && !input.userId) throw new AppError('BAD_REQUEST', 400, 'REVOCATION_SCOPE_REQUIRED');
  if (input.scope === 'team' && !input.teamId) throw new AppError('BAD_REQUEST', 400, 'REVOCATION_SCOPE_REQUIRED');
  if (input.scope === 'connection' && !input.connectionId) throw new AppError('BAD_REQUEST', 400, 'REVOCATION_SCOPE_REQUIRED');
  const now = new Date();
  const scope = { clientDomain: input.clientDomain, ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.teamId ? { teamId: input.teamId } : {}), ...(input.userId ? { userId: input.userId } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}) };
  const assurances = await tx.sessionAssurance.findMany({ where: { ...scope, revokedAt: null }, select: { familyId: true } });
  await tx.sessionAssurance.updateMany({ where: scope, data: { revokedAt: now } });
  if (assurances.length) await tx.refreshToken.updateMany({ where: { familyId: { in: assurances.map((a) => a.familyId) } },
    data: { revokedAt: now } });
  // Legacy exact-org families are included only for authority-wide removals, never a connection-only event.
  if (input.scope !== 'connection') await tx.refreshToken.updateMany({ where: {
    domain: input.clientDomain, ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.teamId ? { teamId: input.teamId } : {}), ...(input.userId ? { userId: input.userId } : {}),
  }, data: { revokedAt: now } });
  return tx.orgRevocationEvent.create({ data: input });
}

export function publicRevocationEvent(row: OrgRevocationEvent) {
  return { id: row.id, schema_version: 1, revision: row.revision, occurred_at: row.occurredAt.toISOString(),
    scope: row.scope, client_domain: row.clientDomain,
    ...(row.orgId ? { org_id: row.orgId } : {}), ...(row.teamId ? { team_id: row.teamId } : {}),
    ...(row.userId ? { user_id: row.userId } : {}), ...(row.connectionId ? { connection_id: row.connectionId } : {}) };
}
const cursorMac = (value: string): string => createHmac('sha256', requireEnv('SHARED_SECRET').SHARED_SECRET)
  .update('uoa.revocation-cursor.v1\0').update(value).digest('base64url');
function encodeCursor(domain: string, sequence: bigint): string {
  const body = Buffer.from(JSON.stringify({ domain, sequence: sequence.toString(), issued: Date.now() })).toString('base64url');
  return `${body}.${cursorMac(body)}`;
}
function decodeCursor(cursor: string, domain: string): bigint {
  try {
    const [body, signature, extra] = cursor.split('.');
    const expected = Buffer.from(cursorMac(body));
    const actual = Buffer.from(signature);
    if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      domain: string; sequence: string; issued: number;
    };
    if (data.domain !== domain || !Number.isSafeInteger(data.issued) ||
      data.issued + 30 * 86400000 < Date.now()) throw new Error();
    return BigInt(data.sequence);
  } catch { throw new AppError('BAD_REQUEST', 409, 'REVOCATION_CURSOR_EXPIRED'); }
}
export async function enterpriseRevocationFeed(domain: string, cursor?: string, limit = 100) {
  const sequence = cursor ? decodeCursor(cursor, domain) : 0n;
  const rows = await getAdminPrisma().orgRevocationEvent.findMany({ where: { clientDomain: domain,
    sequence: { gt: sequence } }, orderBy: { sequence: 'asc' }, take: Math.min(limit, 200) + 1 });
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit);
  return { ok: true, version: 1, events: events.map(publicRevocationEvent), has_more: hasMore,
    next_cursor: encodeCursor(domain, events.at(-1)?.sequence ?? sequence) };
}

export function signRevocationDelivery(body: string, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}
