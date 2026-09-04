import { describe, expect, it } from 'vitest';

import { BILLING_APP_KEY_PREFIX, generateBillingAppKey } from '../../src/utils/billing-app-key.js';

describe('automatic membership app-key contract', () => {
  it('uses the generated uoa_app_ credential format accepted by relying products', () => {
    expect(BILLING_APP_KEY_PREFIX).toBe('uoa_app_');
    expect(generateBillingAppKey()).toMatch(/^uoa_app_[A-Za-z0-9_-]{40,}$/);
  });
});
