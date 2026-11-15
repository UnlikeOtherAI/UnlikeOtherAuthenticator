import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getAdminPrisma } from '../db/prisma.js';
import { getAdminAuthDomain } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import {
  lockBillingAdminEffectAuthority,
  type BillingAdminEffectActor,
} from './billing-admin-effect-authority.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { publicBrowserTariff } from './billing-browser-policy.service.js';

export const BrowserPolicyInput = z
  .object({
    project_id: z.string().uuid(),
    provider_price_per_hour: z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,12})?$/),
    rounding_seconds: z.literal(60),
    source_url: z.string().url().max(1000),
    valid_until: z.string().datetime(),
    expected_policy_id: z.string().min(1).nullable(),
  })
  .strict();
export async function listBrowserPolicies(serviceId: string) {
  const prisma = getAdminPrisma();
  const [policies, pending, reconciliation] = await Promise.all([
    prisma.billingBrowserPolicy.findMany({ where: { serviceId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.billingBrowserReservation.count({
      where: { serviceId, state: { in: ['reserved', 'dispatching'] } },
    }),
    prisma.billingBrowserReservation.count({ where: { serviceId, state: 'reconciliation' } }),
  ]);
  return {
    policies: policies.map((row) => ({
      ...publicBrowserTariff(row),
      source_url: row.sourceUrl,
      retired_at: row.retiredAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    })),
    pending,
    reconciliation,
  };
}
export async function publishBrowserPolicy(
  serviceId: string,
  input: z.infer<typeof BrowserPolicyInput>,
  actor: BillingAdminEffectActor,
) {
  const amount = new Prisma.Decimal(input.provider_price_per_hour);
  const source = new URL(input.source_url);
  const until = new Date(input.valid_until),
    now = new Date();
  if (
    amount.lte(0) ||
    amount.gt(1000) ||
    until.getTime() <= now.getTime() + 3600_000 ||
    until.getTime() > now.getTime() + 90 * 86400_000 ||
    source.protocol !== 'https:' ||
    source.username ||
    source.password ||
    !['www.browserbase.com', 'browserbase.com', 'docs.browserbase.com'].includes(source.hostname)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_BROWSER_POLICY_INVALID');
  }
  return runBillingSerializableTransaction(
    getAdminPrisma(),
    async (tx) => {
      if (!actor.userId) throw new AppError('FORBIDDEN', 403);
      await lockRefreshSessionUserDomain(
        { userId: actor.userId, domain: getAdminAuthDomain() },
        { prisma: tx },
      );
      await lockBillingAdminEffectAuthority(tx, actor);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_services WHERE id=${serviceId} FOR UPDATE`);
      const service = await tx.billingService.findFirst({ where: { id: serviceId, active: true } });
      if (!service) throw new AppError('NOT_FOUND', 404);
      const active = await tx.billingBrowserPolicy.findFirst({
        where: { serviceId, projectId: input.project_id, retiredAt: null },
      });
      if ((active?.id ?? null) !== input.expected_policy_id)
        throw new AppError('BAD_REQUEST', 409, 'BILLING_BROWSER_POLICY_CHANGED');
      if (active)
        await tx.billingBrowserPolicy.update({ where: { id: active.id }, data: { retiredAt: now } });
      return publicBrowserTariff(
        await tx.billingBrowserPolicy.create({
          data: {
            serviceId,
            projectId: input.project_id,
            providerUsdPerHour: amount,
            roundingSeconds: input.rounding_seconds,
            markupBps: 1000,
            minimumSeconds: 60,
            sourceUrl: source.toString(),
            validUntil: until,
            createdByUserId: actor.userId,
          },
        }),
      );
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}
