import { describe, expect, it, vi } from 'vitest';

import {
  resolveTwoFaPolicy,
  strongestTwoFaPolicy,
  toPublicTwoFaPolicy,
  type TwoFaPolicyValue,
} from '../twofactor-policy.service.js';
import type { ClientConfig } from '../config.service.js';

function config(enabled: boolean): Pick<ClientConfig, '2fa_enabled' | 'domain'> {
  return { '2fa_enabled': enabled, domain: 'app.example.com' };
}

function prisma(params: {
  domainPolicy?: TwoFaPolicyValue | null;
  orgPolicies?: Array<TwoFaPolicyValue | null>;
  selectedOrgPolicy?: TwoFaPolicyValue | null;
}) {
  return {
    clientDomain: {
      findUnique: vi.fn(async () =>
        params.domainPolicy ? { twoFaPolicy: params.domainPolicy } : null,
      ),
    },
    organisation: {
      findUnique: vi.fn(async () =>
        params.selectedOrgPolicy ? { twoFaPolicy: params.selectedOrgPolicy } : null,
      ),
      findMany: vi.fn(async () =>
        (params.orgPolicies ?? []).map((twoFaPolicy) => ({ twoFaPolicy })),
      ),
    },
  };
}

describe('twofactor policy resolution', () => {
  it('ranks REQUIRED above OPTIONAL above OFF', () => {
    expect(strongestTwoFaPolicy('OFF', 'OPTIONAL')).toBe('OPTIONAL');
    expect(strongestTwoFaPolicy('OPTIONAL', 'REQUIRED')).toBe('REQUIRED');
    expect(strongestTwoFaPolicy('REQUIRED', 'OFF')).toBe('REQUIRED');
    expect(toPublicTwoFaPolicy('REQUIRED')).toBe('required');
  });

  it('treats legacy config false as master off', async () => {
    const db = prisma({ domainPolicy: 'REQUIRED', orgPolicies: ['REQUIRED'] });

    await expect(
      resolveTwoFaPolicy({ config: config(false), userId: 'user_1' }, { prisma: db }),
    ).resolves.toBe('OFF');
    expect(db.clientDomain.findUnique).not.toHaveBeenCalled();
  });

  it('uses domain default optional when the domain has no registry row', async () => {
    await expect(
      resolveTwoFaPolicy({ config: config(true), userId: 'user_1' }, { prisma: prisma({}) }),
    ).resolves.toBe('OPTIONAL');
  });

  it('takes the strongest policy across the user organisations on the domain', async () => {
    await expect(
      resolveTwoFaPolicy(
        { config: config(true), userId: 'user_1' },
        { prisma: prisma({ domainPolicy: 'OFF', orgPolicies: [null, 'OPTIONAL', 'REQUIRED'] }) },
      ),
    ).resolves.toBe('REQUIRED');
  });

  it('includes the exact selected cross-domain organisation in strongest-wins', async () => {
    await expect(
      resolveTwoFaPolicy(
        { config: config(true), userId: 'user_1', orgId: 'org_cross_product' },
        {
          prisma: prisma({
            domainPolicy: 'OFF',
            orgPolicies: ['OPTIONAL'],
            selectedOrgPolicy: 'REQUIRED',
          }),
        },
      ),
    ).resolves.toBe('REQUIRED');
  });
});
