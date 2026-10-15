import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

/** Call under the canonical user and directory locks. The narrow schema-pinned
 * SQL boundary handles cross-origin subjects without widening tenant RLS. */
export async function requireGroupMembershipAdmission(tx: PrismaClient, orgId: string, userId: string) {
  const [result] = await tx.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`
    SELECT uoa_group_membership_admission(${orgId}, ${userId}) AS allowed`);
  if (result?.allowed !== true) throw new AppError('BAD_REQUEST', 400);
}
