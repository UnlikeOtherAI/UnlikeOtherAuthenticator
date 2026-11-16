import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { getAdminAuthDomain } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  lockBillingAdminEffectAuthority,
  type BillingAdminEffectActor,
} from './billing-admin-effect-authority.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';

export type BillingPeriods = { seatTrialHours: number; seatRenewalGraceHours: number };
type Reader = Pick<Prisma.TransactionClient, '$queryRaw'>;

// The database bounds the same ranges; these keep a refusal a 400 instead of a constraint error.
export const BillingPeriodSettingsInput = z
  .object({
    seat_trial_hours: z.number().int().min(1).max(8760),
    seat_renewal_grace_hours: z.number().int().min(1).max(720),
  })
  .strict();

/** A product's commercial periods. Defaults live in billing_period_setting(), not here. */
export async function readBillingPeriods(tx: Reader, serviceId: string): Promise<BillingPeriods> {
  const rows = await tx.$queryRaw<Array<{ seat_trial_hours: number; seat_renewal_grace_hours: number }>>(
    Prisma.sql`SELECT seat_trial_hours,seat_renewal_grace_hours FROM billing_period_setting(${serviceId})`,
  );
  const row = rows[0];
  if (!row) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PERIOD_SETTINGS_UNAVAILABLE');
  return { seatTrialHours: row.seat_trial_hours, seatRenewalGraceHours: row.seat_renewal_grace_hours };
}

const publicPeriods = (periods: BillingPeriods, updatedAt: Date | null) => ({
  seat_trial_hours: periods.seatTrialHours,
  seat_renewal_grace_hours: periods.seatRenewalGraceHours,
  updated_at: updatedAt?.toISOString() ?? null,
});

export async function getBillingPeriodSettings(serviceId: string) {
  const prisma = getAdminPrisma();
  if (!(await prisma.billingService.findUnique({ where: { id: serviceId }, select: { id: true } }))) {
    throw new AppError('NOT_FOUND', 404);
  }
  const saved = await prisma.billingPeriodSettings.findUnique({ where: { serviceId } });
  return publicPeriods(await readBillingPeriods(prisma, serviceId), saved?.updatedAt ?? null);
}

/** A change applies to periods that start afterwards; a period already running keeps its deadline. */
export async function saveBillingPeriodSettings(
  serviceId: string,
  input: z.infer<typeof BillingPeriodSettingsInput>,
  actor: BillingAdminEffectActor,
) {
  return runBillingSerializableTransaction(
    getAdminPrisma(),
    async (tx) => {
      if (!actor.userId) throw new AppError('FORBIDDEN', 403);
      await lockRefreshSessionUserDomain({ userId: actor.userId, domain: getAdminAuthDomain() }, { prisma: tx });
      await lockBillingAdminEffectAuthority(tx, actor);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_services WHERE id=${serviceId} FOR UPDATE`);
      if (!(await tx.billingService.findUnique({ where: { id: serviceId }, select: { id: true } }))) {
        throw new AppError('NOT_FOUND', 404);
      }
      const data = {
        seatTrialHours: input.seat_trial_hours,
        seatRenewalGraceHours: input.seat_renewal_grace_hours,
        updatedByUserId: actor.userId,
        updatedAt: new Date(),
      };
      const saved = await tx.billingPeriodSettings.upsert({
        where: { serviceId },
        create: { serviceId, ...data },
        update: data,
      });
      return publicPeriods(saved, saved.updatedAt);
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}
