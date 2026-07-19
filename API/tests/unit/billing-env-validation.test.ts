import { describe, expect, it } from 'vitest';

import { isBillingAssertionJwksEnabled, parseEnv } from '../../src/config/env.js';

function baseInput(overrides?: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    DATABASE_URL: 'postgres://example.invalid/db',
    ...overrides,
  };
}

describe('billing environment validation', () => {
  it('keeps Stripe inert unless its explicit gate and dedicated credentials are set', () => {
    const billingPrivateKey = JSON.stringify({
      kty: 'RSA',
      kid: 'uoa-billing-collector-1',
      alg: 'RS256',
      use: 'sig',
      n: 'modulus',
      e: 'AQAB',
      d: 'private',
    });
    const billingPublicKeys = JSON.stringify({
      keys: [
        {
          kty: 'RSA',
          kid: 'uoa-billing-collector-1',
          alg: 'RS256',
          use: 'sig',
          n: 'modulus',
          e: 'AQAB',
        },
      ],
    });
    expect(parseEnv(baseInput()).STRIPE_BILLING_ENABLED).toBe(false);
    expect(isBillingAssertionJwksEnabled(parseEnv(baseInput()))).toBe(false);
    expect(
      parseEnv(
        baseInput({
          STRIPE_SECRET_KEY: 'sk_test_provisioned_early',
          STRIPE_WEBHOOK_SECRET: 'whsec_provisioned_early',
        }),
      ).STRIPE_BILLING_ENABLED,
    ).toBe(false);
    expect(() =>
      parseEnv(
        baseInput({
          STRIPE_BILLING_ENABLED: 'true',
          STRIPE_SECRET_KEY: 'sk_test_missing_webhook',
        }),
      ),
    ).toThrow();
    expect(
      parseEnv(
        baseInput({
          STRIPE_BILLING_ENABLED: 'true',
          STRIPE_SECRET_KEY: 'sk_test_enabled',
          STRIPE_WEBHOOK_SECRET: 'whsec_enabled',
          LEDGER_BILLING_BASE_URL: 'https://ledger.example.com',
          LEDGER_BILLING_APP_KEY: 'lk_uoa_app_key_long_enough_123',
          LEDGER_BILLING_APP_KEY_ID: 'tk_uoa_billing_collector',
          LEDGER_BILLING_ASSERTION_AUDIENCE: 'https://ledger.example.com',
          UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: billingPrivateKey,
          UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: billingPublicKeys,
        }),
      ).STRIPE_BILLING_ENABLED,
    ).toBe(true);
    expect(() =>
      parseEnv(
        baseInput({
          STRIPE_BILLING_ENABLED: 'true',
          STRIPE_SECRET_KEY: 'stripe_mode_unknown',
          STRIPE_WEBHOOK_SECRET: 'whsec_enabled',
          LEDGER_BILLING_BASE_URL: 'https://ledger.example.com',
          LEDGER_BILLING_APP_KEY: 'lk_uoa_app_key_long_enough_123',
          LEDGER_BILLING_APP_KEY_ID: 'tk_uoa_billing_collector',
          LEDGER_BILLING_ASSERTION_AUDIENCE: 'https://ledger.example.com',
          UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: billingPrivateKey,
          UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: billingPublicKeys,
        }),
      ),
    ).toThrow('STRIPE_SECRET_KEY');
    expect(
      isBillingAssertionJwksEnabled(
        parseEnv(
          baseInput({
            UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: billingPrivateKey,
            UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: billingPublicKeys,
          }),
        ),
      ),
    ).toBe(true);
    expect(() =>
      parseEnv(
        baseInput({
          UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: billingPrivateKey,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEnv(
        baseInput({
          UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: billingPrivateKey,
          UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: JSON.stringify({
            keys: [
              {
                kty: 'RSA',
                kid: 'uoa-billing-collector-1',
                alg: 'RS256',
                use: 'sig',
                n: 'wrong-modulus',
                e: 'AQAB',
              },
            ],
          }),
        }),
      ),
    ).toThrow();
  });
});
