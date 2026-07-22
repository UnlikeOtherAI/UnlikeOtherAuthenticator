import { BillingAppKeyPurpose, BillingAssignmentScope } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  authorizeBillingCustomerAction,
  BILLING_CUSTOMER_ACTION,
  billingCustomerActionDigest,
} from '../../src/services/billing-customer-action-intent.service.js';

const credential = {
  id: 'app_key_1',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://app.example',
  actorAudience: 'https://authentication.example/billing',
  actorKeyId: 'key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.example'],
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
};

const request = {
  credential,
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
  authorityScope: BillingAssignmentScope.TEAM,
  operation: BILLING_CUSTOMER_ACTION.CREDIT_TOP_UP,
  actorJti: 'actor_1',
  request: { offer_id: 'offer_1', nested: { b: 'two', a: 'one' } },
};

function row() {
  return {
    id: 'action_1',
    appKeyId: credential.id,
    serviceId: credential.service.id,
    orgId: request.organisationId,
    teamId: request.teamId,
    requestedByUserId: request.userId,
    authorityScope: request.authorityScope,
    operation: request.operation,
    actorJti: request.actorJti,
    requestDigest: billingCustomerActionDigest(request.request),
    createdAt: new Date('2026-07-22T12:00:00.000Z'),
  };
}

describe('customer billing action intents', () => {
  it('uses a canonical digest and replays the same durable authorization intent', async () => {
    expect(
      billingCustomerActionDigest({ nested: { a: 'one', b: 'two' }, offer_id: 'offer_1' }),
    ).toBe(billingCustomerActionDigest(request.request));
    const existing = row();
    const create = vi.fn();
    const prisma = {
      billingCustomerActionIntent: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create,
      },
    };

    await expect(
      authorizeBillingCustomerAction(request, { prisma: prisma as never }),
    ).resolves.toEqual(existing);
    expect(create).not.toHaveBeenCalled();
  });

  it('converges a duplicate insert race onto the winning intent', async () => {
    const winner = row();
    const prisma = {
      billingCustomerActionIntent: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
        create: vi.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' })),
      },
    };

    await expect(
      authorizeBillingCustomerAction(request, { prisma: prisma as never }),
    ).resolves.toEqual(winner);
  });

  it('rejects a replay whose actor action is rebound to different terms', async () => {
    const existing = { ...row(), requestDigest: 'f'.repeat(64) };
    const prisma = {
      billingCustomerActionIntent: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
      },
    };

    await expect(
      authorizeBillingCustomerAction(request, { prisma: prisma as never }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_CUSTOMER_ACTION_REPLAY_CONFLICT',
    });
  });
});
