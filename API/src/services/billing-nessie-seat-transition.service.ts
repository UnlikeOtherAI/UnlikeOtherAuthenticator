import type { Prisma } from '@prisma/client';

/** Caller has resolved an applicable paid seat plan. The database owns the roster lock and cohort. */
export async function nessieSeatTransition(tx: Prisma.TransactionClient, organisationId: string,
  intent: 'projection' | 'admission' = 'admission') {
  // Display reads must not contend with each other or roster changes. Spending
  // admission still takes the database's roster fence, even for an existing cohort.
  if (intent === 'projection') {
    const existing = await tx.billingNessieSeatTransition.findUnique({ where: { orgId: organisationId } });
    if (existing) return existing;
  }
  await tx.$executeRaw`SELECT billing_nessie_start_transition(${organisationId})`;
  return tx.billingNessieSeatTransition.findUnique({ where: { orgId: organisationId } });
}
