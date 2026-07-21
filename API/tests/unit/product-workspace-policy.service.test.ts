import { BillingAppKeyPurpose } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_DOMAIN_WORKSPACE_POLICY,
  resolveProductWorkspacePolicy,
} from '../../src/services/product-workspace-policy.service.js';

describe('product workspace policy', () => {
  it('binds one active client origin to one active customer-lifecycle product', async () => {
    const now = new Date('2026-07-21T21:00:00.000Z');
    const prisma = {
      clientDomain: {
        findUnique: vi.fn().mockResolvedValue({ status: 'active' }),
      },
      billingAppKey: {
        findMany: vi.fn().mockResolvedValue([
          {
            serviceId: 'service-deepsignal',
            service: { identifier: 'deepsignal' },
          },
          {
            serviceId: 'service-deepsignal',
            service: { identifier: 'deepsignal' },
          },
        ]),
      },
    };

    await expect(
      resolveProductWorkspacePolicy({ domain: 'API.DeepSignal.Live.' }, { now: () => now, prisma }),
    ).resolves.toEqual({
      scope: 'all_active_memberships',
      serviceId: 'service-deepsignal',
      product: 'deepsignal',
    });
    expect(prisma.clientDomain.findUnique).toHaveBeenCalledWith({
      where: { domain: 'api.deepsignal.live' },
      select: { status: true },
    });
    expect(prisma.billingAppKey.findMany).toHaveBeenCalledWith({
      where: {
        actorIssuer: 'https://api.deepsignal.live',
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        service: { active: true },
      },
      select: {
        serviceId: true,
        service: { select: { identifier: true } },
      },
    });
  });

  it.each(['inactive', 'pending', 'disabled'])(
    'keeps %s client domains isolated to their own organisations',
    async (status) => {
      const billingAppKey = { findMany: vi.fn() };
      const policy = await resolveProductWorkspacePolicy(
        { domain: 'api.untrusted.example' },
        {
          prisma: {
            clientDomain: { findUnique: vi.fn().mockResolvedValue({ status }) },
            billingAppKey,
          },
        },
      );

      expect(policy).toEqual(CLIENT_DOMAIN_WORKSPACE_POLICY);
      expect(billingAppKey.findMany).not.toHaveBeenCalled();
    },
  );

  it('keeps unknown product domains on the legacy same-domain policy', async () => {
    const policy = await resolveProductWorkspacePolicy(
      { domain: 'api.unknown.example' },
      {
        prisma: {
          clientDomain: { findUnique: vi.fn().mockResolvedValue({ status: 'active' }) },
          billingAppKey: { findMany: vi.fn().mockResolvedValue([]) },
        },
      },
    );

    expect(policy).toEqual(CLIENT_DOMAIN_WORKSPACE_POLICY);
  });

  it('fails closed when one actor issuer ambiguously maps to multiple products', async () => {
    const policy = await resolveProductWorkspacePolicy(
      { domain: 'api.ambiguous.example' },
      {
        prisma: {
          clientDomain: { findUnique: vi.fn().mockResolvedValue({ status: 'active' }) },
          billingAppKey: {
            findMany: vi.fn().mockResolvedValue([
              { serviceId: 'service-a', service: { identifier: 'a' } },
              { serviceId: 'service-b', service: { identifier: 'b' } },
            ]),
          },
        },
      },
    );

    expect(policy).toEqual(CLIENT_DOMAIN_WORKSPACE_POLICY);
  });
});
