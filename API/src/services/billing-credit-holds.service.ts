import type { Prisma, PrismaClient } from '@prisma/client';

type HoldClient = Pick<PrismaClient | Prisma.TransactionClient,
  'billingPrepaidReservation' | 'billingSmsReservation' | 'billingSmsStandingHold' | 'billingVoiceReservation' | 'billingBrowserReservation'>;

/** The same canonical balance protects AI, outbound SMS and inbound standing funds. */
export async function billingReservedMicrocredits(client: HoldClient, creditAccountId: string): Promise<bigint> {
  const [ai, sms, inbound, voice, browser] = await Promise.all([
    client.billingPrepaidReservation.aggregate({
      where: { creditAccountId, status: 'ACTIVE' }, _sum: { reservedMicrocredits: true },
    }),
    client.billingSmsReservation.aggregate({
      where: { creditAccountId, state: { in: ['reserved', 'dispatching', 'uncertain', 'reconciliation'] } },
      _sum: { reservedMicrocredits: true },
    }),
    client.billingSmsStandingHold.aggregate({
      where: { creditAccountId }, _sum: { reservedMicrocredits: true },
    }),
    client.billingVoiceReservation.aggregate({
      where: { creditAccountId, state: { in: ['reserved', 'dispatching', 'uncertain', 'reconciliation'] } },
      _sum: { reservedMicrocredits: true },
    }),
    client.billingBrowserReservation.aggregate({
      where: { creditAccountId, state: { in: ['reserved', 'dispatching', 'reconciliation'] } },
      _sum: { reservedMicrocredits: true },
    }),
  ]);
  return (ai._sum.reservedMicrocredits ?? 0n) + (sms._sum.reservedMicrocredits ?? 0n) +
    (inbound._sum.reservedMicrocredits ?? 0n) + (voice._sum.reservedMicrocredits ?? 0n) + (browser._sum.reservedMicrocredits ?? 0n);
}
