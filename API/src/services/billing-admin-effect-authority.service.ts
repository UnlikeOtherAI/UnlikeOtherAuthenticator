import { Prisma, UserRole } from '@prisma/client';

import { getAdminAuthDomain } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export type BillingAdminEffectActor = {
  userId?: string | null;
  tokenVersion?: number | null;
  email: string;
  domain?: string | null;
};

type AuthorityTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>;

export async function lockBillingAdminEffectAuthority(
  tx: AuthorityTransaction,
  actor: BillingAdminEffectActor,
): Promise<void> {
  const userId = actor.userId?.trim();
  const tokenVersion = actor.tokenVersion;
  const email = actor.email.trim().toLowerCase();
  const domain = getAdminAuthDomain();
  const assertedDomain = actor.domain?.trim().toLowerCase();
  if (
    !userId ||
    !Number.isSafeInteger(tokenVersion) ||
    (tokenVersion as number) < 0 ||
    !email ||
    (assertedDomain && assertedDomain !== domain)
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_ADMIN_AUTHORITY_REQUIRED');
  }
  const rows = await tx.$queryRaw<
    Array<{ id: string; email: string; role: UserRole; tokenVersion: number }>
  >(
    Prisma.sql`
      SELECT user_row."id", user_row."email", user_row."token_version" AS "tokenVersion",
             role_row."role"
      FROM "users" user_row
      JOIN "domain_roles" role_row
        ON role_row."user_id" = user_row."id"
       AND role_row."domain" = ${domain}
      WHERE user_row."id" = ${userId}
      FOR UPDATE OF user_row, role_row
    `,
  );
  const current = rows[0];
  if (
    !current ||
    current.role !== UserRole.SUPERUSER ||
    current.tokenVersion !== tokenVersion ||
    current.email.trim().toLowerCase() !== email
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_ADMIN_AUTHORITY_REQUIRED');
  }
}
