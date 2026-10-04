import { Prisma, type PrismaClient } from '@prisma/client';

export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export function afterPayerLock(client: PrismaClient,
  action: () => Promise<void>): PrismaClient {
  return new Proxy(client, { get(target, property, receiver) {
    if (property !== '$transaction') return Reflect.get(target, property, receiver);
    return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
      target.$transaction(async (tx) => callback(new Proxy(tx, {
        get(transaction, method, transactionReceiver) {
          if (method !== '$queryRaw') return Reflect.get(transaction, method, transactionReceiver);
          return async (...args: unknown[]) => {
            const result = await (transaction.$queryRaw as (...values: unknown[]) =>
              Promise<unknown>)(...args);
            const sql = String((args[0] as { strings?: readonly string[] })?.strings?.join('') ?? '');
            if (sql.includes('billing_credit_accounts') && sql.includes('FOR UPDATE')) {
              await action();
            }
            return result;
          };
        },
      })), options as never);
  } });
}

export async function waitForPayerWait(prisma: PrismaClient): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%billing_credit_accounts%FOR UPDATE%'`);
    if ((waiting[0]?.count ?? 0n) > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('competing transaction did not wait on the credit payer row');
}
