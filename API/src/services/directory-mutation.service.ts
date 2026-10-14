import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { runInTransaction } from '../db/tenant-context.js';

export type DirectoryChange = {
  orgId: string;
  kind:
    | 'organisation.changed'
    | 'organisation.deleted'
    | 'team.changed'
    | 'team.deleted'
    | 'membership.changed'
    | 'profile.changed'
    | 'credential_epoch.changed';
  subjectId?: string;
  teamId?: string;
};
const held = new WeakMap<object, string[]>();

/** Call before mutation, after the operation's canonical user/policy locks and
 * before container/membership row locks. Resolve the COMPLETE affected org set
 * up front. A nested writer may reuse that set but cannot extend it: acquiring
 * a new set midway would defeat sorted ordering and risk deadlock.
 *
 * No publication runs after commit: writes, revisions and events share this tx.
 * Both callers and canonical writer coverage must be audited before cutover.
 */
export async function withDirectoryMutation<T>(
  prisma: PrismaClient,
  changes: readonly DirectoryChange[],
  write: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return runInTransaction(prisma, async (tx) => {
    const orgIds = [...new Set(changes.map((change) => change.orgId))].sort();
    if (orgIds.some((id) => !id))
      throw new Error('Directory mutation requires exact organisation IDs');
    const existing = held.get(tx);
    if (existing && orgIds.some((id) => !existing.includes(id))) {
      throw new Error('Directory mutation must resolve all organisations before its first write');
    }
    if (!existing) {
      for (const orgId of orgIds) {
        const key = `uoa:directory-org:v1:${orgId}`;
        await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${key}, 0))::text AS "lockResult"`);
      }
      held.set(tx, orgIds);
    }
    // Keep the transaction's declared set until commit, including sequential
    // nested service calls. A TransactionClient has transaction-bounded identity.
    const result = await write(tx);
    for (const change of changes) {
      // The narrow SQL boundary checks tenant context, keeps direct app-role
      // access denied, and allocates/inserts atomically under the same lock.
      await tx.$queryRaw(Prisma.sql`SELECT uoa_record_directory_change(
        ${randomUUID()}, ${change.orgId}, ${change.kind},
        ${change.subjectId ?? null}, ${change.teamId ?? null}) AS revision`);
    }
    return result;
  });
}
