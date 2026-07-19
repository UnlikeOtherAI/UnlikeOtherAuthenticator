import { describe, expect, it } from 'vitest';

import {
  ConfidentialDelegationFormSchema,
  ConfidentialDelegationMappingSchema,
} from './confidential-delegation';

describe('confidential delegation schemas', () => {
  it('normalizes a valid operator form at the boundary', () => {
    expect(
      ConfidentialDelegationFormSchema.parse({
        sourceDomain: ' API.DeepWater.Live ',
        product: ' DeepWater ',
        resource: ' https://ledger.unlikeotherai.com ',
        scopes: ['ai.invoke'],
        enabled: true,
      }),
    ).toEqual({
      sourceDomain: 'api.deepwater.live',
      product: 'deepwater',
      resource: 'https://ledger.unlikeotherai.com',
      scopes: ['ai.invoke'],
      enabled: true,
    });
  });

  it.each([
    {
      name: 'a source URL instead of a hostname',
      input: {
        sourceDomain: 'https://api.deepwater.live',
        product: 'deepwater',
        resource: 'https://ledger.unlikeotherai.com',
        scopes: ['ai.invoke'],
      },
    },
    {
      name: 'an insecure resource',
      input: {
        sourceDomain: 'api.deepwater.live',
        product: 'deepwater',
        resource: 'http://ledger.unlikeotherai.com',
        scopes: ['ai.invoke'],
      },
    },
    {
      name: 'malformed resource text',
      input: {
        sourceDomain: 'api.deepwater.live',
        product: 'deepwater',
        resource: 'not a url',
        scopes: ['ai.invoke'],
      },
    },
    {
      name: 'an empty scope allowlist',
      input: {
        sourceDomain: 'api.deepwater.live',
        product: 'deepwater',
        resource: 'https://ledger.unlikeotherai.com',
        scopes: [],
      },
    },
    {
      name: 'duplicate scopes',
      input: {
        sourceDomain: 'api.deepwater.live',
        product: 'deepwater',
        resource: 'https://ledger.unlikeotherai.com',
        scopes: ['ai.invoke', 'ai.invoke'],
      },
    },
  ])('rejects $name', ({ input }) => {
    expect(ConfidentialDelegationFormSchema.safeParse(input).success).toBe(false);
  });

  it('rejects an untrusted API response shape', () => {
    expect(
      ConfidentialDelegationMappingSchema.safeParse({
        id: 'mapping-1',
        source_domain: 'api.deepwater.live',
        product: 'deepwater',
        resource: 'https://ledger.unlikeotherai.com',
        scopes: ['admin.everything'],
        enabled: true,
        created_by_email: null,
        updated_by_email: null,
        created_at: '2026-07-19T00:00:00.000Z',
        updated_at: '2026-07-19T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
