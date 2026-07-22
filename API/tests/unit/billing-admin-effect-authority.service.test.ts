import { UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { lockBillingAdminEffectAuthority } from '../../src/services/billing-admin-effect-authority.service.js';

describe('billing admin effect authority', () => {
  it('accepts only the currently locked exact SUPERUSER identity', async () => {
    const query = vi
      .fn()
      .mockResolvedValue([
        {
          id: 'admin_1',
          email: 'Admin@Example.com',
          role: UserRole.SUPERUSER,
          tokenVersion: 7,
        },
      ]);

    await expect(
      lockBillingAdminEffectAuthority({ $queryRaw: query } as never, {
        userId: 'admin_1',
        tokenVersion: 7,
        email: 'admin@example.com',
      }),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });

  it('fails before a monetary transaction when the current role was revoked', async () => {
    await expect(
      lockBillingAdminEffectAuthority(
        {
          $queryRaw: vi
            .fn()
            .mockResolvedValue([
              {
                id: 'admin_1',
                email: 'admin@example.com',
                role: UserRole.USER,
                tokenVersion: 7,
              },
            ]),
        } as never,
        { userId: 'admin_1', tokenVersion: 7, email: 'admin@example.com' },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'BILLING_ADMIN_AUTHORITY_REQUIRED',
    });
  });

  it('rejects a token whose credential epoch was revoked before the locked effect', async () => {
    await expect(
      lockBillingAdminEffectAuthority(
        {
          $queryRaw: vi.fn().mockResolvedValue([
            {
              id: 'admin_1',
              email: 'admin@example.com',
              role: UserRole.SUPERUSER,
              tokenVersion: 8,
            },
          ]),
        } as never,
        { userId: 'admin_1', tokenVersion: 7, email: 'admin@example.com' },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'BILLING_ADMIN_AUTHORITY_REQUIRED',
    });
  });
});
