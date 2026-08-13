import { Prisma, type PrismaClient } from '@prisma/client';

/** Serialize signature-policy mutation with every authorization/session decision. */
export async function lockSignaturePolicyForDecision(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  domain: string,
): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`SELECT 1 FROM "domain_signature_settings" WHERE "domain" = ${domain} FOR UPDATE`,
  );
}
