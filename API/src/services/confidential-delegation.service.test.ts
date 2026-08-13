import { describe, expect, it } from 'vitest';

import { FIRST_PARTY_CONFIDENTIAL_DELEGATIONS } from './confidential-delegation.service.js';

describe('first-party confidential delegation registry', () => {
  it('pins DocGen to its exact source domain and Ledger ai.invoke audience', () => {
    expect(FIRST_PARTY_CONFIDENTIAL_DELEGATIONS.docgen).toEqual({
      sourceDomain: 'buildme.live',
      resource: 'https://ledger.unlikeotherai.com',
      scopes: ['ai.invoke'],
    });
  });
});
