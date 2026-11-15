import type { Prisma } from '@prisma/client';

/** Caller has resolved an applicable paid seat plan. The database owns the roster lock and cohort. */
export async function nessieSeatTransition(tx: Prisma.TransactionClient, organisationId: string) {
  await tx.$executeRaw`SELECT billing_nessie_start_transition(${organisationId})`;
  return tx.billingNessieSeatTransition.findUnique({ where: { orgId: organisationId } });
}
