import { BillingAppKeyPurpose, MembershipStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  billingAccessFingerprint,
  confirmAuthenticatedDirectBillingServiceAccess,
  confirmDirectBillingServiceAccess,
  listDirectTeamBillingServiceAccess,
} from '../../src/services/billing-service-access.service.js';

const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'deepwater_billing_2026_07',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};

describe('UOA-owned direct product access', () => {
  it('confirms direct SSO access only after actor and active membership verification', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const verifyActor = vi.fn().mockResolvedValue({});
    const upsert = vi.fn().mockResolvedValue({});
    const tx = {
      billingService: {
        findFirst: vi.fn().mockResolvedValue({ id: credential.service.id }),
      },
      orgMember: {
        findUnique: vi.fn().mockResolvedValue({ status: MembershipStatus.ACTIVE }),
      },
      team: {
        findFirst: vi.fn().mockResolvedValue({ id: 'team_1' }),
      },
      billingServiceAccess: { upsert },
    };
    const transaction = vi.fn(async (callback) => callback(tx));

    await confirmAuthenticatedDirectBillingServiceAccess(
      {
        credential,
        actorToken: 'signed-actor',
        request: {
          product: 'deepwater',
          organisationId: 'org_1',
          teamId: 'team_1',
          userId: 'user_1',
        },
      },
      {
        prisma: { $transaction: transaction } as never,
        now: () => now,
        verifyActor,
      },
    );

    expect(verifyActor).toHaveBeenCalledWith({
      token: 'signed-actor',
      credential,
      request: {
        product: 'deepwater',
        organisationId: 'org_1',
        teamId: 'team_1',
        userId: 'user_1',
      },
    });
    expect(tx.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'team_1',
          orgId: 'org_1',
          members: {
            some: {
              userId: 'user_1',
              status: MembershipStatus.ACTIVE,
            },
          },
        }),
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          firstConfirmedAt: now,
          lastConfirmedAt: now,
        }),
      }),
    );
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    );
  });

  it('does not record a direct product when active team membership is absent', async () => {
    const verifyActor = vi.fn().mockResolvedValue({});
    const upsert = vi.fn();
    const tx = {
      billingService: {
        findFirst: vi.fn().mockResolvedValue({ id: credential.service.id }),
      },
      orgMember: {
        findUnique: vi.fn().mockResolvedValue({ status: MembershipStatus.ACTIVE }),
      },
      team: { findFirst: vi.fn().mockResolvedValue(null) },
      billingServiceAccess: { upsert },
    };

    await expect(
      confirmAuthenticatedDirectBillingServiceAccess(
        {
          credential,
          actorToken: 'signed-actor',
          request: {
            product: 'deepwater',
            organisationId: 'org_1',
            teamId: 'team_1',
            userId: 'user_1',
          },
        },
        {
          prisma: {
            $transaction: vi.fn(async (callback) => callback(tx)),
          } as never,
          verifyActor,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'BILLING_SUBJECT_NOT_ENTITLED',
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('records direct access from the authenticated product key, not Ledger', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const upsert = vi.fn().mockResolvedValue({});

    await confirmDirectBillingServiceAccess(
      {
        serviceId: 'service_deepwater',
        appKeyId: 'app_key_deepwater',
        organisationId: 'org_1',
        teamId: 'team_1',
        userId: 'user_1',
      },
      {
        prisma: { billingServiceAccess: { upsert } } as never,
        now: () => now,
      },
    );

    expect(upsert).toHaveBeenCalledWith({
      where: {
        serviceId_teamId_userId: {
          serviceId: 'service_deepwater',
          teamId: 'team_1',
          userId: 'user_1',
        },
      },
      create: expect.objectContaining({
        serviceId: 'service_deepwater',
        appKeyId: 'app_key_deepwater',
        orgId: 'org_1',
        firstConfirmedAt: now,
        lastConfirmedAt: now,
      }),
      update: expect.objectContaining({
        appKeyId: 'app_key_deepwater',
        active: true,
        revokedAt: null,
        lastConfirmedAt: now,
      }),
    });
  });

  it('collapses access into stable per-service user sets and fingerprints', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        serviceId: 'service_nessie',
        userId: 'user_2',
        service: { identifier: 'nessie', name: 'Nessie', active: true },
      },
      {
        serviceId: 'service_nessie',
        userId: 'user_1',
        service: { identifier: 'nessie', name: 'Nessie', active: true },
      },
      {
        serviceId: 'service_old',
        userId: 'user_1',
        service: { identifier: 'old', name: 'Old', active: false },
      },
    ]);
    const result = await listDirectTeamBillingServiceAccess(
      { organisationId: 'org_1', teamId: 'team_1' },
      {
        prisma: {
          billingServiceAccess: {
            findMany,
          },
        } as never,
      },
    );

    expect(result).toEqual([
      {
        serviceId: 'service_nessie',
        product: 'nessie',
        name: 'Nessie',
        userIds: ['user_1', 'user_2'],
      },
    ]);
    expect(billingAccessFingerprint(result)).toMatch(/^[a-f0-9]{64}$/);
    expect(billingAccessFingerprint(result)).toBe(
      billingAccessFingerprint([
        {
          ...result[0]!,
          userIds: ['user_2', 'user_1'],
        },
      ]),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user: {
            orgMembers: {
              some: { orgId: 'org_1', status: 'ACTIVE' },
            },
            teamMembers: {
              some: { teamId: 'team_1', status: 'ACTIVE' },
            },
          },
        }),
      }),
    );
  });
});
