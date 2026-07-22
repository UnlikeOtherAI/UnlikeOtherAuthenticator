import { BillingCollectionMode, BillingTariffMode, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import {
  stripeBillingPeriodPhase,
  stripeCalendarBillingMonth,
} from './billing-stripe-period.service.js';
import { exportStripeUsage } from './billing-stripe-usage.service.js';
import { STRIPE_METERABLE_SUBSCRIPTION_STATUSES } from './billing-stripe-usage-validation.service.js';
import {
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
} from './billing-stripe-client.service.js';
import {
  runCreditAutoTopUpCycle,
  startCreditAutoTopUpScheduler,
} from './billing-credit-auto-top-up-runtime.service.js';

type StripeSchedulerClient = Pick<Stripe, 'accounts' | 'billing'>;

export type StripeUsageCycleResult = {
  accountId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  skippedAlignmentPeriods: number;
  preBoundarySafetyPasses: number;
  results: Array<{
    subscriptionId: string;
    billingMonth: string | null;
    preBoundarySafetyPass: boolean;
    preBoundarySafetyPassAt?: string;
    skippedReason?: 'free_alignment_period';
    ledgerSnapshotCursor?: string;
    error?: string;
  }>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'UNKNOWN_STRIPE_USAGE_EXPORT_FAILURE';
}

export async function runStripeUsageExportCycle(deps?: {
  prisma?: PrismaClient;
  stripe?: StripeSchedulerClient;
  stripeLivemode?: boolean;
  exportUsage?: typeof exportStripeUsage;
  now?: () => Date;
  safetyLeadMinutes?: number;
  safetyOffsetMinutes?: number;
}): Promise<StripeUsageCycleResult> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) {
    throw new Error('STRIPE_BILLING_DISABLED');
  }
  const account = await resolveStripeAccountContext(
    stripe,
    deps?.stripeLivemode ?? configured?.livemode ?? false,
    prisma,
  );
  const now = deps?.now?.() ?? new Date();
  const safetyLeadMinutes =
    deps?.safetyLeadMinutes ?? getEnv().STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES;
  const safetyOffsetMinutes =
    deps?.safetyOffsetMinutes ?? getEnv().STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES;
  const subscriptions = await prisma.billingStripeSubscription.findMany({
    where: {
      accountId: account.id,
      livemode: account.livemode,
      status: { in: [...STRIPE_METERABLE_SUBSCRIPTION_STATUSES] },
      currentPeriodStart: { not: null, lte: now },
      currentPeriodEnd: { not: null, gt: now },
      service: { active: true },
      tariff: {
        collectionMode: BillingCollectionMode.STRIPE,
        mode: { not: BillingTariffMode.FREE },
      },
    },
    select: {
      id: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
    },
    orderBy: { id: 'asc' },
  });

  const results: StripeUsageCycleResult['results'] = [];
  for (const subscription of subscriptions) {
    if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) continue;
    const month = stripeCalendarBillingMonth(
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
    );
    if (!month) {
      const phase = stripeBillingPeriodPhase(
        subscription.currentPeriodStart,
        subscription.currentPeriodEnd,
      );
      results.push({
        subscriptionId: subscription.id,
        billingMonth: null,
        preBoundarySafetyPass: false,
        ...(phase === 'free_alignment_period'
          ? { skippedReason: 'free_alignment_period' as const }
          : { error: 'STRIPE_BILLING_PERIOD_NOT_CALENDAR_ALIGNED' }),
      });
      continue;
    }
    const safetyAt = new Date(
      subscription.currentPeriodEnd.getTime() - safetyOffsetMinutes * 60_000,
    );
    const inSafetyWindow =
      subscription.currentPeriodEnd.getTime() - now.getTime() <= safetyLeadMinutes * 60_000;
    const preBoundarySafetyPass =
      now.getTime() >= safetyAt.getTime() &&
      now.getTime() < subscription.currentPeriodEnd.getTime();
    const preBoundarySafetyPassAt =
      inSafetyWindow && now.getTime() < safetyAt.getTime() ? safetyAt.toISOString() : undefined;
    try {
      const result = await (deps?.exportUsage ?? exportStripeUsage)(
        {
          subscriptionId: subscription.id,
          billingMonth: month,
        },
        {
          prisma,
          stripe,
          stripeLivemode: account.livemode,
          now: () => now,
        },
      );
      results.push({
        subscriptionId: subscription.id,
        billingMonth: month,
        preBoundarySafetyPass,
        ...(preBoundarySafetyPassAt ? { preBoundarySafetyPassAt } : {}),
        ledgerSnapshotCursor: result.ledgerSnapshotCursor,
      });
    } catch (error) {
      results.push({
        subscriptionId: subscription.id,
        billingMonth: month,
        preBoundarySafetyPass,
        ...(preBoundarySafetyPassAt ? { preBoundarySafetyPassAt } : {}),
        error: errorMessage(error),
      });
    }
  }

  return {
    accountId: account.id,
    attempted: results.filter((result) => !result.skippedReason).length,
    succeeded: results.filter((result) => !result.error && !result.skippedReason).length,
    failed: results.filter((result) => Boolean(result.error)).length,
    skippedAlignmentPeriods: results.filter((result) => Boolean(result.skippedReason)).length,
    preBoundarySafetyPasses: results.filter(
      (result) => result.preBoundarySafetyPass && !result.error,
    ).length,
    results,
  };
}

export function startStripeUsageExportScheduler(params: {
  log: {
    info: (details: object, message: string) => void;
    error: (details: object, message: string) => void;
  };
  runCycle?: typeof runStripeUsageExportCycle;
}): { stop: () => void } {
  const env = getEnv();
  let running = false;
  let stopped = false;
  let rerunRequested = false;
  const safetyTimers = new Map<string, NodeJS.Timeout>();
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      const result = await (params.runCycle ?? runStripeUsageExportCycle)();
      for (const item of result.results) {
        if (!item.preBoundarySafetyPassAt) continue;
        const timerKey = `${item.subscriptionId}:${item.preBoundarySafetyPassAt}`;
        if (safetyTimers.has(timerKey)) continue;
        const delay = Date.parse(item.preBoundarySafetyPassAt) - Date.now();
        if (delay <= 0) {
          rerunRequested = true;
          continue;
        }
        const safetyTimer = setTimeout(() => {
          safetyTimers.delete(timerKey);
          void run();
        }, delay);
        safetyTimer.unref();
        safetyTimers.set(timerKey, safetyTimer);
      }
      const details = {
        attempted: result.attempted,
        succeeded: result.succeeded,
        failed: result.failed,
        skippedAlignmentPeriods: result.skippedAlignmentPeriods,
        preBoundarySafetyPasses: result.preBoundarySafetyPasses,
        failures: result.results
          .filter((item) => item.error)
          .map((item) => ({
            subscriptionId: item.subscriptionId,
            billingMonth: item.billingMonth,
            error: item.error,
          })),
      };
      if (result.failed > 0) {
        params.log.error(details, 'Stripe usage export cycle completed');
      } else {
        params.log.info(details, 'Stripe usage export cycle completed');
      }
    } catch (error) {
      params.log.error({ err: error }, 'Stripe usage export cycle failed');
    } finally {
      running = false;
      if (rerunRequested && !stopped) {
        rerunRequested = false;
        queueMicrotask(() => void run());
      }
    }
  };

  void run();
  const timer = setInterval(() => void run(), env.STRIPE_USAGE_EXPORT_INTERVAL_MINUTES * 60_000);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const safetyTimer of safetyTimers.values()) clearTimeout(safetyTimer);
      safetyTimers.clear();
    },
  };
}

export function startStripeBillingScheduler(params: {
  log: {
    info: (details: object, message: string) => void;
    error: (details: object, message: string) => void;
  };
  runUsageCycle?: typeof runStripeUsageExportCycle;
  runAutoTopUpCycle?: typeof runCreditAutoTopUpCycle;
}): { stop: () => void } {
  const usage = startStripeUsageExportScheduler({
    log: params.log,
    ...(params.runUsageCycle ? { runCycle: params.runUsageCycle } : {}),
  });
  const automaticTopUp = startCreditAutoTopUpScheduler({
    log: params.log,
    ...(params.runAutoTopUpCycle ? { runCycle: params.runAutoTopUpCycle } : {}),
  });
  return {
    stop: () => {
      usage.stop();
      automaticTopUp.stop();
    },
  };
}
