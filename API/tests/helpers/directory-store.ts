import { vi } from 'vitest';

/** Explicitly unbound subjects in focused factor/profile fixtures. Bound-user
 * runtime cases must seed real memberships instead of using this helper. */
export function unboundDirectoryUserStore() {
  return { $queryRaw: vi.fn().mockResolvedValue([]),
    orgMember: { findMany: vi.fn().mockResolvedValue([]) },
    organisation: { findMany: vi.fn().mockResolvedValue([]) } };
}

/** Prisma supplies a fresh TransactionClient without $transaction. Returning
 * the root fake would retain transaction-local directory plans across commits. */
export function asTransaction<T extends object>(client: T): T {
  const tx = { ...client };
  Reflect.deleteProperty(tx, '$transaction');
  return tx;
}
