import { Prisma, type PrismaClient } from '@prisma/client';

/** Operator configuration survives the creator, but its profile attribution does not. */
export async function scrubOperatorAttribution(tx: PrismaClient, user: { id: string; email: string | null; name: string | null; userKey: string | null }, erase: boolean) {
  const byEmail = user.email ? { equals: user.email, mode: 'insensitive' as const } : undefined;
  await tx.adminApiKey.updateMany({ where: { OR: [{ createdByUserId: user.id }, ...(byEmail ? [{ createdByEmail: byEmail }] : [])] },
    data: { createdByUserId: null, createdByEmail: null, revokedAt: new Date(), name: 'Deleted operator key' } });
  for (const field of ['created', 'updated'] as const) {
    await tx.confidentialDelegationMapping.updateMany({ where: { OR: [{ [`${field}ByUserId`]: user.id }, ...(byEmail ? [{ [`${field}ByEmail`]: byEmail }] : [])] },
      data: { [`${field}ByUserId`]: null, [`${field}ByEmail`]: null } });
  }
  await tx.billingAppKey.updateMany({ where: { OR: [{ createdByUserId: user.id }, ...(byEmail ? [{ createdByEmail: byEmail }] : [])] }, data: { createdByUserId: null, createdByEmail: null } });
  if (byEmail) {
    await tx.clientDomainJwk.updateMany({ where: { createdByEmail: byEmail }, data: { createdByEmail: null } });
    await tx.clientDomainIntegrationRequest.deleteMany({ where: { contactEmail: byEmail } });
    await tx.clientDomainIntegrationRequest.updateMany({ where: { reviewedByEmail: byEmail }, data: { reviewedByEmail: null, declineReason: null } });
    for (const table of ['organisations', 'teams', 'client_domains']) {
      // Match normalized array members, including mixed case, without loading unbounded rows.
      await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(table)} SET allowed_emails = ARRAY(
        SELECT entry FROM unnest(allowed_emails) AS entry WHERE lower(entry) <> lower(${user.email})
      ) WHERE EXISTS (SELECT 1 FROM unnest(allowed_emails) AS entry WHERE lower(entry)=lower(${user.email}))`);
    }
  }
  if (erase) await tx.entityDeletionJob.updateMany({ where: { actorUserId: user.id }, data: { actorUserId: null } });
}
