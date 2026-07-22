import { describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../config.service.js';
import { assertAuthorizationTwoFaProof } from '../authorization-twofactor-proof.service.js';

const config = {
  domain: 'product.example.com',
  '2fa_enabled': true,
} as ClientConfig;

function prisma(params: { enrolled: boolean; selectedPolicy: 'OFF' | 'OPTIONAL' | 'REQUIRED' }) {
  return {
    clientDomain: {
      findUnique: vi.fn().mockResolvedValue({ twoFaPolicy: 'OFF' }),
    },
    organisation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ twoFaPolicy: params.selectedPolicy }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ twoFaEnabled: params.enrolled }),
    },
  };
}

describe('authorization-code 2FA proof revalidation', () => {
  it.each([false, true])(
    'rejects missing proof when the exact selected org is REQUIRED (enrolled=%s)',
    async (enrolled) => {
      await expect(
        assertAuthorizationTwoFaProof(
          {
            config,
            userId: 'user-1',
            orgId: 'org-cross',
            twoFaCompleted: false,
          },
          { prisma: prisma({ enrolled, selectedPolicy: 'REQUIRED' }) as never },
        ),
      ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_AUTH_CODE' });
    },
  );

  it('rejects missing proof for an enrolled user under OPTIONAL policy', async () => {
    await expect(
      assertAuthorizationTwoFaProof(
        {
          config,
          userId: 'user-1',
          orgId: 'org-cross',
          twoFaCompleted: false,
        },
        { prisma: prisma({ enrolled: true, selectedPolicy: 'OPTIONAL' }) as never },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_AUTH_CODE' });
  });

  it('accepts completed proof under the strongest exact-org policy', async () => {
    await expect(
      assertAuthorizationTwoFaProof(
        {
          config,
          userId: 'user-1',
          orgId: 'org-cross',
          twoFaCompleted: true,
        },
        { prisma: prisma({ enrolled: false, selectedPolicy: 'REQUIRED' }) as never },
      ),
    ).resolves.toBeUndefined();
  });
});
