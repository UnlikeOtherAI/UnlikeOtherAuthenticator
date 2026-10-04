import {
  BillingRecurringAddonCancellationIntentState,
  BillingRecurringAddonSubscriptionScope,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/billing-entitlement.service.js', () => ({
  resolveEffectiveTariffContext: vi.fn().mockResolvedValue({ actor: { jti: 'actor_1' } }),
}));
vi.mock('../../src/services/billing-funding-viewer.service.js', () => ({
  resolveBillingFundingViewer: vi.fn().mockResolvedValue({
    organisationRole: 'admin',
    teamRole: 'member',
  }),
}));

import { billingAddonCopy } from '../../src/services/billing-addon-copy.catalog.js';
import { confirmRecurringAddonCancellation } from '../../src/services/billing-recurring-addon-cancellation-confirm.service.js';
import {
  recurringAddonCancellationDigest,
  scopeForSubscription,
} from '../../src/services/billing-recurring-addon-cancellation-preview.service.js';
import { recurringAddonSubjectFingerprint } from '../../src/services/billing-recurring-addon-scope.service.js';

const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};
const credential = {
  id: 'app_key_deepwater',
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
const previewToken = 'uoa_recurring_cancel_0123456789abcdefghijklmnopqrstuvwxyz';
const idempotencyKey = 'uoa_recurring_confirm_0123456789abcdefghijklmnopqrstuvwxyz';

function replayFixture() {
  const subscription = {
    id: 'subscription_1',
    offerId: 'offer_1',
    orgId: request.organisationId,
    teamId: request.teamId,
    scope: BillingRecurringAddonSubscriptionScope.TEAM,
    scopeKey: `${request.organisationId}:${request.teamId}`,
    subscribingUserId: null,
  };
  const subjectFingerprint = recurringAddonSubjectFingerprint({
    appKeyId: credential.id,
    serviceId: credential.service.id,
    offerId: subscription.offerId,
    subject: request,
    scope: scopeForSubscription(subscription as never),
  });
  const digest = (value: string) => recurringAddonCancellationDigest(value);
  const confirmationRequestDigest = digest(
    JSON.stringify({
      product: request.product,
      organisation_id: request.organisationId,
      team_id: request.teamId,
      user_id: request.userId,
      preview_token_digest: digest(previewToken),
      idempotency_key: idempotencyKey,
      choice: 'cancel_addon',
    }),
  );
  const copy = billingAddonCopy('en-US');
  const intent = {
    id: 'intent_1',
    appKeyId: credential.id,
    serviceId: credential.service.id,
    orgId: request.organisationId,
    requestedTeamId: request.teamId,
    requestedByUserId: request.userId,
    idempotencyKey,
    subjectFingerprint,
    confirmationRequestDigest,
    state: BillingRecurringAddonCancellationIntentState.COMPLETED,
    result: {
      schema_version: 1,
      status: 'scheduled',
      title: copy.confirmationScheduled,
      description: copy.confirmationDescription,
      cancellation_effective_at: '2026-08-01T00:00:00.000Z',
    },
    subscription,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: intent.id }]),
    billingRecurringAddonCancellationIntent: {
      findUnique: vi.fn().mockResolvedValue(intent),
    },
  };
  const prisma = {
    billingRecurringAddonCancellationIntent: {
      findUnique: vi.fn().mockResolvedValue(intent),
    },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return { prisma, intent };
}

describe('recurring add-on cancellation confirmation copy', () => {
  it('relocalizes a replayed confirmation without repeating payment work', async () => {
    const { prisma, intent } = replayFixture();
    const result = await confirmRecurringAddonCancellation(
      {
        request: {
          ...request,
          previewToken,
          idempotencyKey,
          choice: 'cancel_addon',
        },
        actorToken: 'signed-actor',
        credential: credential as never,
        endpoint: {} as never,
        locale: 'cs',
      },
      { prisma: prisma as never },
    );

    expect(result).toMatchObject({
      status: 'scheduled',
      title: 'Zrušení je naplánováno',
      description: 'Placený doplněk zůstane dostupný do konce aktuálního období.',
      cancellation_effective_at: '2026-08-01T00:00:00.000Z',
    });
    expect(intent.result).toMatchObject({ title: 'Cancellation scheduled' });
  });

  it('keeps the stored cancellation outcome and effective date on replay', async () => {
    const { prisma } = replayFixture();
    const result = await confirmRecurringAddonCancellation(
      {
        request: {
          ...request,
          previewToken,
          idempotencyKey,
          choice: 'cancel_addon',
        },
        actorToken: 'signed-actor',
        credential: credential as never,
        endpoint: {} as never,
        locale: 'cs',
      },
      { prisma: prisma as never },
    );

    expect(result.status).toBe('scheduled');
    expect(result.cancellation_effective_at).toBe('2026-08-01T00:00:00.000Z');
  });
});
