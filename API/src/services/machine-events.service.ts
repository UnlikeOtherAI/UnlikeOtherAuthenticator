import { z } from 'zod';
import type { MachineAuthorityEvent } from '@prisma/client';
import { machineEqual, machineMac, machineRefused } from './machine-crypto.js';
import { machineClock, machineTransaction, type MachineDb } from './machine-authority.service.js';

const integer = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const Cursor = z.object({ version: z.literal(1), domain: z.string().min(1),
  after_tx: integer, after_sequence: integer, ceiling: integer.nullable(), issued_at: z.number().int().safe() }).strict();
type CursorData = z.infer<typeof Cursor>;
const DAY = 86_400_000;
function encode(data: CursorData) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${body}.${machineMac('cursor', body)}`;
}
export function decodeMachineCursor(value: string, domain: string, now = Date.now()): CursorData {
  try {
    const [body, signature, extra] = value.split('.');
    if (!body || !signature || extra || !machineEqual(machineMac('cursor', body), signature)) throw new Error();
    const data = Cursor.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (data.domain !== domain || data.issued_at > now || data.issued_at + DAY <= now ||
      (data.ceiling !== null && BigInt(data.ceiling) < BigInt(data.after_tx))) throw new Error();
    return data;
  } catch { machineRefused(409, 'MACHINE_CURSOR_EXPIRED'); }
}
/** No transaction with an older xid can commit an event behind this watermark. */
async function watermark(tx: MachineDb): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ floor: string }>>`
    SELECT txid_snapshot_xmin(txid_current_snapshot())::text AS floor`;
  return row.floor;
}
export async function machineCheckpoint(domain: string) {
  return machineTransaction(async tx => {
    const floor = await watermark(tx); const now = await machineClock(tx);
    return { version: 1, next_cursor: encode({ version: 1, domain, after_tx: floor,
      after_sequence: '0', ceiling: null, issued_at: now.getTime() }), high_water: floor };
  });
}
export function publicMachineEvent(row: MachineAuthorityEvent) {
  return { version: 1, id: row.id, client_domain: row.clientDomain, original_grant_id: row.enrollmentId,
    authorization_id: row.authorizationId, credential_generation: row.credentialGeneration,
    source_version: row.sourceVersion.toString(), decision: row.status, reason: row.reason,
    occurred_at: row.occurredAt.toISOString() };
}
export async function machineFeed(domain: string, cursor: string, limit = 100) {
  return machineTransaction(async tx => {
    const now = await machineClock(tx); const input = decodeMachineCursor(cursor, domain, now.getTime());
    const ceiling = input.ceiling ?? await watermark(tx);
    if (BigInt(ceiling) < BigInt(input.after_tx)) machineRefused(409, 'MACHINE_CURSOR_EXPIRED');
    const rows = await tx.machineAuthorityEvent.findMany({ where: { clientDomain: domain,
      transactionId: { lt: BigInt(ceiling) }, OR: [ { transactionId: { gt: BigInt(input.after_tx) } },
        { transactionId: BigInt(input.after_tx), sequence: { gt: BigInt(input.after_sequence) } } ] },
      orderBy: [{ transactionId: 'asc' }, { sequence: 'asc' }], take: limit + 1 });
    const more = rows.length > limit; const events = rows.slice(0, limit); const last = events.at(-1);
    const next = more && last ? { ...input, after_tx: last.transactionId.toString(),
      after_sequence: last.sequence.toString(), ceiling } : { ...input, after_tx: ceiling,
      after_sequence: '0', ceiling: null, issued_at: now.getTime() };
    return { version: 1, events: events.map(publicMachineEvent), has_more: more,
      next_cursor: encode(next), high_water: ceiling };
  });
}
/** Current fences only. This response is deliberately NOT a key-proven admission. */
export async function reconcileMachineFences(domain: string, ids: string[], tx: MachineDb) {
  const rows = await tx.machineEnrollment.findMany({ where: { id: { in: ids }, clientDomain: domain } });
  return { version: 1, fences: ids.map(id => {
    const row = rows.find(item => item.id === id);
    return row ? { original_grant_id: row.id, authorization_id: row.currentAuthorizationId,
      credential_generation: row.credentialGeneration, source_version: row.sourceVersion.toString(),
      decision: row.status, reason: row.reason } : { original_grant_id: id, decision: 'unknown' };
  }), admission: false };
}
