import type { PrismaClient } from '@prisma/client';

export type AdminConnectionLease = {
  /** Transaction client pinned to the leased admin connection. */
  readonly db: PrismaClient;
  /** Return the connection to the admin pool. Idempotent and never throws. */
  release(): Promise<void>;
};

/**
 * Check out one admin-pool connection now and hold it until `release()`.
 *
 * A tenant transaction takes the canonical user epoch lock on its app connection and then reads
 * live authority through the BYPASSRLS admin client. Admin writers for the same user (sign-in,
 * refresh, confidential exchange) hold an admin connection while they wait for that lock. With
 * the production pool of two admin connections, two such writers left the lock holder waiting for
 * a connection they occupied: a pool/lock cycle PostgreSQL cannot detect, broken only when every
 * participant hit the 5 s interactive-transaction timeout (P2028). A tenant transaction that
 * leases its admin connection *before* taking the lock never waits for the admin pool while
 * holding it. See row-level-security.md §10.16.
 *
 * The lease is an interactive transaction that runs only the caller's plain reads, so it holds no
 * lock of its own; READ COMMITTED gives each read the latest committed state, exactly as the
 * global client did. Prisma's default `maxWait` and `timeout` bound the checkout and the hold.
 */
export function leaseAdminConnection(adminDb: PrismaClient): Promise<AdminConnectionLease> {
  return new Promise((resolveLease, rejectLease) => {
    let finish!: () => void;
    const finished = new Promise<void>((done) => { finish = done; });
    let settled: Promise<unknown> = Promise.resolve();
    let leased = false;
    const release = async (): Promise<void> => {
      finish();
      // A lease that expired after its reads completed has nothing left to report.
      await settled.catch(() => undefined);
    };
    settled = adminDb.$transaction(async (tx) => {
      leased = true;
      resolveLease({ db: tx as unknown as PrismaClient, release });
      await finished;
    });
    settled.catch((error: unknown) => {
      if (!leased) rejectLease(error);
    });
  });
}
