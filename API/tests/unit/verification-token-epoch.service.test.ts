import { describe, expect, it, vi } from 'vitest';

import {
  lockAndReadVerificationTokenEpoch,
  readVerificationTokenEpoch,
} from '../../src/services/verification-token-epoch.service.js';

describe('verification-token epoch proofs', () => {
  it('accepts a genuine pre-user registration capability only while its userKey is absent', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);

    await expect(
      readVerificationTokenEpoch({ user: { findUnique } } as never, {
        userId: null,
        tokenVersion: null,
        userKey: 'new@example.com',
      }),
    ).resolves.toEqual({ kind: 'registration' });

    findUnique.mockResolvedValue({ id: 'user-1' });
    await expect(
      readVerificationTokenEpoch({ user: { findUnique } } as never, {
        userId: null,
        tokenVersion: null,
        userKey: 'new@example.com',
      }),
    ).resolves.toBeNull();
  });

  it.each([
    { userId: 'user-1', tokenVersion: null },
    { userId: null, tokenVersion: 0 },
  ])('fails closed for a partially bound legacy proof %#', async (proof) => {
    const findUnique = vi.fn();

    await expect(
      readVerificationTokenEpoch({ user: { findUnique } } as never, {
        ...proof,
        userKey: 'user@example.com',
      }),
    ).resolves.toBeNull();

    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts only the exact issue-time user, userKey, and credential epoch', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'user-1',
      userKey: 'user@example.com',
      tokenVersion: 7,
    });
    const proof = { userId: 'user-1', tokenVersion: 7, userKey: 'user@example.com' };

    await expect(
      readVerificationTokenEpoch({ user: { findUnique } } as never, proof),
    ).resolves.toEqual({ kind: 'user', userId: 'user-1', credentialEpoch: 7 });

    findUnique.mockResolvedValue({
      id: 'user-1',
      userKey: 'user@example.com',
      tokenVersion: 8,
    });
    await expect(
      readVerificationTokenEpoch({ user: { findUnique } } as never, proof),
    ).resolves.toBeNull();
  });

  it('takes the user lock before reading the live epoch', async () => {
    const order: string[] = [];
    const prisma = {
      $queryRaw: vi.fn(async () => {
        order.push('lock');
      }),
      user: {
        findUnique: vi.fn(async () => {
          order.push('read');
          return { id: 'user-1', userKey: 'user@example.com', tokenVersion: 8 };
        }),
      },
    };

    await expect(
      lockAndReadVerificationTokenEpoch(
        prisma as never,
        { userId: 'user-1', tokenVersion: 7, userKey: 'user@example.com' },
        async () => {
          order.push('after-lock');
        },
      ),
    ).resolves.toBeNull();

    expect(order).toEqual(['lock', 'after-lock', 'read']);
  });
});
