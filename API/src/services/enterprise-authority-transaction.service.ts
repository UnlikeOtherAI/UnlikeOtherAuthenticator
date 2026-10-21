import type { PrismaClient } from '@prisma/client';
import { runInTransaction } from '../db/tenant-context.js';
import { lockEnterpriseOutbox } from './org-sso-revocation.service.js';

/** Authority writers acquire the committed-feed fence before policy, identity or row locks.
 * Keep this explicit: unrelated billing and read transactions do not serialize on the outbox. */
export function runEnterpriseAuthorityTransaction<T>(
  prisma: PrismaClient,
  body: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return runInTransaction(prisma, async (tx) => {
    await lockEnterpriseOutbox(tx);
    return body(tx);
  });
}
