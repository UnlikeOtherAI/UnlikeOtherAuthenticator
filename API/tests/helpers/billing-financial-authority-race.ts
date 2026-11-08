import { Prisma, type PrismaClient } from '@prisma/client';

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export type RaceResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Handle rejection immediately, including failures before a test reaches its gate. */
export function raceResult<T>(promise: PromiseLike<T>): Promise<RaceResult<T>> {
  return Promise.resolve(promise).then(value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }));
}

/** Signal only after the winning effect, but reject the signal if it cannot run. */
export function holdFinancialTransaction(db: PrismaClient,
  effect: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  const ready = deferred<number>();
  const gate = deferred();
  const result = raceResult(db.$transaction(async tx => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await effect(tx);
    ready.resolve(pid);
    await gate.promise;
  }));
  void result.then(outcome => { if (!outcome.ok) ready.reject(outcome.error); });
  return { ready: ready.promise, release: () => gate.resolve(), result };
}

/** Capture the exact contender PID before its statement can wait on a row lock. */
export function startFinancialTransaction(db: PrismaClient,
  effect: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  const started = deferred<number>();
  const result = raceResult(db.$transaction(async tx => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    started.resolve(pid);
    return effect(tx);
  }));
  void result.then(outcome => { if (!outcome.ok) started.reject(outcome.error); });
  return { started: started.promise, result };
}

export async function waitForFinancialLock(db: PrismaClient, waitingPid: number, blockingPid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    // Another contender may queue first on the same row. Follow only this
    // backend's real blocker chain to the exact winning transaction.
    const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
      WITH RECURSIVE blockers(pid) AS (
        SELECT unnest(pg_blocking_pids(${waitingPid}::integer))
        UNION
        SELECT upstream.pid FROM blockers previous
          CROSS JOIN LATERAL unnest(pg_blocking_pids(previous.pid)) AS upstream(pid)
      )
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${waitingPid}
        AND wait_event_type='Lock' AND EXISTS(SELECT 1 FROM blockers WHERE pid=${blockingPid})) AS blocked`);
    if (row.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The exact financial contender did not wait on the winning transaction');
}
