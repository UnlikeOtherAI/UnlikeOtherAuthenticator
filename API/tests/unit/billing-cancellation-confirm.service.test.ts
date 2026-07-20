import {
  BillingAppKeyPurpose,
  BillingAssignmentScope,
  BillingCancellationIntentState,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { confirmBillingCancellation } from '../../src/services/billing-cancellation-confirm.service.js';

const now = new Date('2026-07-20T12:01:00.000Z');
const token = 'uoa_cancel_0123456789abcdefghijklmnopqrstuvwxyz';
const idempotencyKey = 'uoa_confirm_0123456789abcdefghijklmnopqrstuvwxyz';
const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};
const account = {
  id: 'account_1',
  stripeAccountId: 'acct_1',
  livemode: false,
  createdAt: now,
  updatedAt: now,
};

function subscription(params: { id: string; serviceId: string; identifier: string; name: string }) {
  return {
    id: params.id,
    accountId: account.id,
    checkoutId: `checkout_${params.id}`,
    customerId: 'customer_1',
    serviceId: params.serviceId,
    tariffId: `tariff_${params.serviceId}`,
    tariffSource: 'TEAM',
    tariffAssignmentId: `assignment_${params.serviceId}`,
    orgId: 'org_1',
    teamId: 'team_1',
    scope: BillingAssignmentScope.TEAM,
    scopeKey: 'org_1:team_1',
    stripeSubscriptionId: `sub_${params.id}`,
    stripeMonthlyItemId: `si_monthly_${params.id}`,
    stripeUsageItemId: `si_usage_${params.id}`,
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    livemode: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: now,
    service: {
      id: params.serviceId,
      identifier: params.identifier,
      name: params.name,
    },
    account,
  };
}

describe('billing cancellation confirmation', () => {
  it('locks, revalidates, cancels the pinned rows, and replays one completed result', async () => {
    const current = subscription({
      id: 'subscription_deepwater',
      serviceId: 'service_deepwater',
      identifier: 'deepwater',
      name: 'DeepWater',
    });
    const related = subscription({
      id: 'subscription_nessie',
      serviceId: 'service_nessie',
      identifier: 'nessie',
      name: 'Nessie',
    });
    const state = {
      accesses: [],
      subscriptions: [current, related],
      entitlementFingerprint: 'a'.repeat(64),
      subscriptionFingerprint: 'b'.repeat(64),
    };
    const intent = {
      id: 'intent_1',
      tokenDigest: createHash('sha256').update(token).digest('hex'),
      appKeyId: credential.id,
      serviceId: credential.service.id,
      orgId: request.organisationId,
      teamId: request.teamId,
      requestedByUserId: request.userId,
      directServiceIds: [current.serviceId, related.serviceId],
      directSubscriptionIds: [current.id, related.id],
      indirectServiceIds: ['deepsignal'],
      entitlementFingerprint: state.entitlementFingerprint,
      subscriptionFingerprint: state.subscriptionFingerprint,
      state: BillingCancellationIntentState.AVAILABLE,
      idempotencyKey: null as string | null,
      requestDigest: null as string | null,
      result: null as unknown,
      expiresAt: new Date('2026-07-20T12:05:00.000Z'),
      consumedAt: null as Date | null,
      createdAt: new Date('2026-07-20T12:00:00.000Z'),
      updatedAt: new Date('2026-07-20T12:00:00.000Z'),
    };
    const auditCreate = vi.fn().mockResolvedValue({});
    const intentUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(intent, data);
      return intent;
    });
    const intentUpdateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (intent.state !== BillingCancellationIntentState.PROCESSING) {
        return { count: 0 };
      }
      Object.assign(intent, data);
      return { count: 1 };
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: intent.id }]),
      billingCancellationIntent: {
        findUnique: vi.fn(async () => intent),
        update: intentUpdate,
        updateMany: intentUpdateMany,
      },
      orgAuditLog: { create: auditCreate },
    };
    const prisma = {
      ...tx,
      billingStripeSubscription: {
        findMany: vi.fn(async () =>
          [current, related].map((item) => ({
            ...item,
            cancelAtPeriodEnd: true,
          })),
        ),
      },
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const stripeUpdate = vi.fn(async (stripeSubscriptionId: string) => ({
      id: stripeSubscriptionId,
      livemode: false,
      cancel_at_period_end: true,
    }));
    const syncSubscription = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      prisma: prisma as never,
      stripe: {
        accounts: { retrieveCurrent: vi.fn() },
        subscriptions: { update: stripeUpdate },
      } as never,
      now: () => now,
      resolveSummary: vi.fn().mockResolvedValue({
        can_manage: true,
        subscription: { id: current.id },
      }) as never,
      loadState: vi.fn().mockResolvedValue(state) as never,
      resolveAccount: vi.fn().mockResolvedValue(account) as never,
      syncSubscription,
    };

    const params = {
      request,
      actorToken: 'signed-actor',
      credential,
      token,
      idempotencyKey,
      selection: 'current_and_related_direct_services' as const,
    };
    const first = await confirmBillingCancellation(params, dependencies);
    const replay = await confirmBillingCancellation(params, dependencies);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      schema_version: 1,
      status: 'confirmed',
      cancelled_services: [
        { product: 'deepwater', status: 'cancels_at_period_end' },
        { product: 'nessie', status: 'cancels_at_period_end' },
      ],
      indirect_services: [
        {
          product: 'deepsignal',
          impact: 'No separate subscription was cancelled.',
        },
      ],
    });
    expect(stripeUpdate).toHaveBeenCalledTimes(2);
    expect(stripeUpdate).toHaveBeenNthCalledWith(
      1,
      current.stripeSubscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: `uoa_cancel_${intent.id}_${current.id}` },
    );
    expect(syncSubscription).toHaveBeenCalledTimes(2);
    expect(intent.state).toBe(BillingCancellationIntentState.COMPLETED);
    expect(intent.result).toEqual(first);
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it('requires an explicit choice when the preview pinned related direct services', async () => {
    const current = subscription({
      id: 'subscription_deepwater',
      serviceId: 'service_deepwater',
      identifier: 'deepwater',
      name: 'DeepWater',
    });
    const related = subscription({
      id: 'subscription_nessie',
      serviceId: 'service_nessie',
      identifier: 'nessie',
      name: 'Nessie',
    });
    const intent = {
      id: 'intent_1',
      appKeyId: credential.id,
      serviceId: credential.service.id,
      orgId: request.organisationId,
      teamId: request.teamId,
      requestedByUserId: request.userId,
      directServiceIds: [current.serviceId, related.serviceId],
      directSubscriptionIds: [current.id, related.id],
      indirectServiceIds: [],
      entitlementFingerprint: 'a'.repeat(64),
      subscriptionFingerprint: 'b'.repeat(64),
      state: BillingCancellationIntentState.AVAILABLE,
      idempotencyKey: null,
      requestDigest: null,
      result: null,
      expiresAt: new Date('2026-07-20T12:05:00.000Z'),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: intent.id }]),
      billingCancellationIntent: {
        findUnique: vi.fn().mockResolvedValue(intent),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    };

    await expect(
      confirmBillingCancellation(
        {
          request,
          actorToken: 'signed-actor',
          credential,
          token,
          idempotencyKey,
          selection: null,
        },
        {
          prisma: prisma as never,
          now: () => now,
          resolveSummary: vi.fn().mockResolvedValue({
            can_manage: true,
            subscription: { id: current.id },
          }) as never,
          loadState: vi.fn().mockResolvedValue({
            accesses: [],
            subscriptions: [current, related],
            entitlementFingerprint: 'a'.repeat(64),
            subscriptionFingerprint: 'b'.repeat(64),
          }) as never,
        },
      ),
    ).rejects.toThrow('BILLING_CANCELLATION_CHOICE_REQUIRED');
  });
});
