import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

/** Global occupancy only; the definer function never returns another tenant's identity. */
export async function isOrganisationSlugTaken(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  slug: string,
): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ taken: boolean }[]>(
    Prisma.sql`SELECT uoa_organisation_slug_taken(${slug}) AS taken`,
  );
  if (typeof row?.taken !== 'boolean') throw new AppError('INTERNAL', 500);
  return row.taken;
}

export function isOrganisationSlugConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  return error.meta?.modelName === 'Organisation'
    && (Array.isArray(target) ? target.includes('slug') : target === 'organisations_slug_admission_key');
}

/** A concurrent allocation has the same public outcome as the advisory availability check. */
export async function withChosenOrganisationSlug<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (isOrganisationSlugConflict(error)) throw new AppError('BAD_REQUEST', 400, 'ORG_SLUG_TAKEN');
    throw error;
  }
}

/** Retry the existing automatic suffix allocator after a concurrent claim. */
export async function withAutomaticOrganisationSlug<T>(
  tx: Pick<Prisma.TransactionClient, '$executeRawUnsafe'>,
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await tx.$executeRawUnsafe('SAVEPOINT uoa_automatic_org_slug');
    try {
      const result = await operation();
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT uoa_automatic_org_slug');
      return result;
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT uoa_automatic_org_slug');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT uoa_automatic_org_slug');
      if (!isOrganisationSlugConflict(error)) throw error;
    }
  }
  throw new AppError('INTERNAL', 500, 'ORG_SLUG_COLLISION_RETRY_EXHAUSTED');
}
