import { BillingAppKeyPurpose, BillingAssignmentScope } from '@prisma/client';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createBillingCancellationPreview } from '../../src/services/billing-cancellation-preview.service.js';

const now = new Date('2026-07-20T12:00:00.000Z');
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
};

function subscription(params: {
  id: string;
  serviceId: string;
  identifier: string;
  name: string;
  accountId?: string;
}) {
  return {
    id: params.id,
    accountId: params.accountId ?? account.id,
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
    account: {
      ...account,
      id: params.accountId ?? account.id,
    },
  };
}

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
const anotherAccount = subscription({
  id: 'subscription_deeptest_other_account',
  serviceId: 'service_deeptest',
  identifier: 'deeptest',
  name: 'DeepTest',
  accountId: 'account_2',
});

function statement() {
  return {
    capabilities: { can_cancel: true },
    subscription: { id: current.id },
    services: [
      {
        product: 'deepsignal',
        name: null,
        display_name: 'DeepSignal',
        access: 'indirect',
      },
    ],
  };
}

describe('billing cancellation preview', () => {
  it('pins only exact same-account direct subscriptions and never offers indirect services', async () => {
    const create = vi.fn().mockResolvedValue({});
    const preview = await createBillingCancellationPreview(
      { request, actorToken: 'signed-actor', credential },
      {
        prisma: {
          billingCancellationIntent: { create },
        } as never,
        now: () => now,
        getStatement: vi.fn().mockResolvedValue(statement()) as never,
        loadState: vi.fn().mockResolvedValue({
          accesses: [
            {
              serviceId: 'service_deepwater',
              product: 'deepwater',
              name: 'DeepWater',
              userIds: ['user_1'],
            },
            {
              serviceId: 'service_nessie',
              product: 'nessie',
              name: 'Nessie',
              userIds: ['user_1', 'user_2'],
            },
            {
              serviceId: 'service_deeptest',
              product: 'deeptest',
              name: 'DeepTest',
              userIds: ['user_2'],
            },
          ],
          subscriptions: [current, related, anotherAccount],
          entitlementFingerprint: 'a'.repeat(64),
          subscriptionFingerprint: 'b'.repeat(64),
        }) as never,
      },
    );

    expect(preview).toMatchObject({
      schema_version: 1,
      choice_required: true,
      choices: [
        {
          id: 'current_service',
          service_ids: ['service_deepwater'],
        },
        {
          id: 'current_and_related_direct_services',
          service_ids: ['service_deepwater', 'service_nessie'],
        },
      ],
      direct_services: [
        {
          product: 'deepwater',
          direct_user_count: 1,
        },
        {
          product: 'nessie',
          direct_user_count: 2,
        },
      ],
      indirect_services: [
        {
          product: 'deepsignal',
          impact: 'No separate subscription will be cancelled.',
        },
      ],
      confirm_action: {
        path: '/billing/v1/cancellation/confirm',
        selection_required: true,
        default_selection: null,
      },
    });
    expect(preview.preview_token).toMatch(/^uoa_cancel_/);
    expect(preview.confirm_action.idempotency_key).toMatch(/^uoa_confirm_/);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenDigest: createHash('sha256').update(preview.preview_token).digest('hex'),
        directServiceIds: ['service_deepwater', 'service_nessie'],
        directSubscriptionIds: [current.id, related.id],
        indirectServiceIds: ['deepsignal'],
        expiresAt: new Date('2026-07-20T12:05:00.000Z'),
      }),
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain(preview.preview_token);
    expect(preview.direct_services.map((service) => service.product)).not.toContain('deeptest');
  });

  it('omits a choice when the only related service is Ledger-only indirect use', async () => {
    const preview = await createBillingCancellationPreview(
      { request, actorToken: 'signed-actor', credential },
      {
        prisma: {
          billingCancellationIntent: { create: vi.fn().mockResolvedValue({}) },
        } as never,
        now: () => now,
        getStatement: vi.fn().mockResolvedValue(statement()) as never,
        loadState: vi.fn().mockResolvedValue({
          accesses: [
            {
              serviceId: 'service_deepwater',
              product: 'deepwater',
              name: 'DeepWater',
              userIds: ['user_1'],
            },
          ],
          subscriptions: [current],
          entitlementFingerprint: 'a'.repeat(64),
          subscriptionFingerprint: 'b'.repeat(64),
        }) as never,
      },
    );

    expect(preview.choice_required).toBe(false);
    expect(preview.choices).toEqual([]);
    expect(preview.confirm_action).toMatchObject({
      selection_required: false,
      default_selection: 'current_service',
    });
  });
});
