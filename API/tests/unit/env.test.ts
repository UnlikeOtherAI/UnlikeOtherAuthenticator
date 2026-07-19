import { describe, expect, it } from 'vitest';

import {
  getAdminAuthDomain,
  getAuthServiceIdentifier,
  isBillingAssertionJwksEnabled,
  isMcpOAuthPublicProfileEnabled,
  isOAuthAccessTokenJwksEnabled,
  isTariffSnapshotJwksEnabled,
  parseEnv,
} from '../../src/config/env.js';

function baseInput(overrides?: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    ADMIN_ACCESS_TOKEN_SECRET: 'admin-token-secret-with-enough-length',
    CONFIG_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
    CONFIG_JWKS_JSON: '{"keys":[{"kty":"RSA","kid":"test","n":"abc","e":"AQAB"}]}',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    REFRESH_TOKEN_TTL_DAYS: '30',
    LOG_RETENTION_DAYS: '90',
    ...overrides,
  };
}

describe('env', () => {
  it('accepts ses as EMAIL_PROVIDER', () => {
    const env = parseEnv(baseInput({ EMAIL_PROVIDER: 'ses', AWS_REGION: 'eu-west-1' }));
    expect(env.EMAIL_PROVIDER).toBe('ses');
    expect(env.AWS_REGION).toBe('eu-west-1');
  });

  it('accepts sendgrid as EMAIL_PROVIDER', () => {
    const env = parseEnv(
      baseInput({ EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'SG.example-key' }),
    );
    expect(env.EMAIL_PROVIDER).toBe('sendgrid');
    expect(env.SENDGRID_API_KEY).toBe('SG.example-key');
  });

  it('rejects unsupported EMAIL_PROVIDER values', () => {
    expect(() => parseEnv(baseInput({ EMAIL_PROVIDER: 'mailgun' }))).toThrow();
  });

  it('allows admin and JWKS secrets to be transferred after boot', () => {
    const input = baseInput();
    Reflect.deleteProperty(input, 'ADMIN_ACCESS_TOKEN_SECRET');
    Reflect.deleteProperty(input, 'CONFIG_JWKS_URL');
    Reflect.deleteProperty(input, 'CONFIG_JWKS_JSON');
    expect(parseEnv(input).ADMIN_ACCESS_TOKEN_SECRET).toBeUndefined();
    expect(parseEnv(input).CONFIG_JWKS_URL).toBeUndefined();
    expect(parseEnv(input).CONFIG_JWKS_JSON).toBeUndefined();
    expect(
      parseEnv(
        baseInput({
          ADMIN_AUTH_DOMAIN: 'admin.example.com',
          ADMIN_ACCESS_TOKEN_SECRET: 'admin-token-secret-with-enough-length',
        }),
      ).ADMIN_AUTH_DOMAIN,
    ).toBe('admin.example.com');
  });

  it('does not require AUTH_SERVICE_IDENTIFIER when PUBLIC_BASE_URL is set', () => {
    const input = baseInput();
    Reflect.deleteProperty(input, 'AUTH_SERVICE_IDENTIFIER');

    const env = parseEnv(input);

    expect(env.AUTH_SERVICE_IDENTIFIER).toBeUndefined();
    expect(getAuthServiceIdentifier(env)).toBe('auth.example.com');
    expect(getAdminAuthDomain(env)).toBe('auth.example.com');
  });

  it('falls back to HOST:PORT when no public URL or identifier is set', () => {
    const input = baseInput();
    Reflect.deleteProperty(input, 'AUTH_SERVICE_IDENTIFIER');
    Reflect.deleteProperty(input, 'PUBLIC_BASE_URL');

    const env = parseEnv(input);

    expect(getAuthServiceIdentifier(env)).toBe('127.0.0.1:3000');
    expect(getAdminAuthDomain(env)).toBe('127.0.0.1:3000');
  });

  it('uses ADMIN_AUTH_DOMAIN as the normalized admin domain when set', () => {
    const env = parseEnv(baseInput({ ADMIN_AUTH_DOMAIN: 'Admin.Example.Com.' }));

    expect(getAdminAuthDomain(env)).toBe('admin.example.com');
  });

  it('accepts ACCESS_TOKEN_TTL in the 15m-60m window (inclusive)', () => {
    expect(parseEnv(baseInput({ ACCESS_TOKEN_TTL: '15m' })).ACCESS_TOKEN_TTL).toBe('15m');
    expect(parseEnv(baseInput({ ACCESS_TOKEN_TTL: '60m' })).ACCESS_TOKEN_TTL).toBe('60m');
    expect(parseEnv(baseInput({ ACCESS_TOKEN_TTL: '30m' })).ACCESS_TOKEN_TTL).toBe('30m');
  });

  it('trims ACCESS_TOKEN_TTL', () => {
    expect(parseEnv(baseInput({ ACCESS_TOKEN_TTL: ' 30m ' })).ACCESS_TOKEN_TTL).toBe('30m');
  });

  it('rejects ACCESS_TOKEN_TTL outside the allowed window', () => {
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '14m' }))).toThrow();
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '61m' }))).toThrow();
  });

  it('rejects non-minute formats for ACCESS_TOKEN_TTL', () => {
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '1800s' }))).toThrow();
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '1h' }))).toThrow();
    expect(() => parseEnv(baseInput({ ACCESS_TOKEN_TTL: '30' }))).toThrow();
  });

  it('keeps the public OAuth profile off when only the resource-token signer is configured', () => {
    const env = parseEnv(
      baseInput({
        MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: '{}',
      }),
    );

    expect(isOAuthAccessTokenJwksEnabled(env)).toBe(true);
    expect(isMcpOAuthPublicProfileEnabled(env)).toBe(false);
    expect(env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED).toBe(false);
  });

  it('enables tariff snapshots only with a matching private key and overlapping public JWKS', () => {
    const privateKey = JSON.stringify({
      kty: 'RSA',
      kid: 'tariff-2026-07',
      alg: 'RS256',
      use: 'sig',
      n: 'modulus',
      e: 'AQAB',
      d: 'private',
    });
    const publicKeys = JSON.stringify({
      keys: [
        {
          kty: 'RSA',
          kid: 'tariff-2026-06',
          alg: 'RS256',
          use: 'sig',
          n: 'retired-modulus',
          e: 'AQAB',
        },
        {
          kty: 'RSA',
          kid: 'tariff-2026-07',
          alg: 'RS256',
          use: 'sig',
          n: 'modulus',
          e: 'AQAB',
        },
      ],
    });

    expect(isTariffSnapshotJwksEnabled(parseEnv(baseInput()))).toBe(false);
    expect(
      isTariffSnapshotJwksEnabled(
        parseEnv(
          baseInput({
            TARIFF_SNAPSHOT_PRIVATE_JWK: privateKey,
            TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON: publicKeys,
          }),
        ),
      ),
    ).toBe(true);
    expect(() =>
      parseEnv(
        baseInput({
          TARIFF_SNAPSHOT_PRIVATE_JWK: JSON.stringify({
            kty: 'RSA',
            kid: 'public-only',
            alg: 'RS256',
            use: 'sig',
            n: 'modulus',
            e: 'AQAB',
          }),
          TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON: publicKeys,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEnv(
        baseInput({
          TARIFF_SNAPSHOT_PRIVATE_JWK: JSON.stringify({
            kty: 'RSA',
            kid: 'wrong-algorithm',
            alg: 'ES256',
            n: 'modulus',
            e: 'AQAB',
            d: 'private',
          }),
          TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON: publicKeys,
        }),
      ),
    ).toThrow();
    expect(() => parseEnv(baseInput({ TARIFF_SNAPSHOT_PRIVATE_JWK: privateKey }))).toThrow();
    expect(() => parseEnv(baseInput({ TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON: publicKeys }))).toThrow();
    expect(() =>
      parseEnv(
        baseInput({
          TARIFF_SNAPSHOT_PRIVATE_JWK: privateKey,
          TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON: JSON.stringify({
            keys: [
              {
                kty: 'RSA',
                kid: 'tariff-2026-07',
                alg: 'RS256',
                use: 'sig',
                n: 'different-modulus',
                e: 'AQAB',
              },
            ],
          }),
        }),
      ),
    ).toThrow();
  });

  it('keeps Stripe inert unless its explicit gate and both dedicated secrets are set', () => {
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

  it('requires an explicit flag, signing key, and dedicated domain for public OAuth', () => {
    expect(() => parseEnv(baseInput({ MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'true' }))).toThrow();
    expect(() =>
      parseEnv(
        baseInput({
          MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'true',
          MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: '{}',
        }),
      ),
    ).toThrow();

    const env = parseEnv(
      baseInput({
        MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'true',
        MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: '{}',
        MCP_OAUTH_DOMAIN: 'oauth.example.com',
      }),
    );
    expect(isMcpOAuthPublicProfileEnabled(env)).toBe(true);
  });

  it('fails the public OAuth gate closed when its domain is the admin domain', () => {
    const env = parseEnv(
      baseInput({
        ADMIN_AUTH_DOMAIN: 'oauth.example.com',
        MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'true',
        MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: '{}',
        MCP_OAUTH_DOMAIN: 'oauth.example.com',
      }),
    );
    expect(isMcpOAuthPublicProfileEnabled(env)).toBe(false);
  });

  it('accepts REFRESH_TOKEN_TTL_DAYS between 1 and 90', () => {
    expect(parseEnv(baseInput({ REFRESH_TOKEN_TTL_DAYS: '1' })).REFRESH_TOKEN_TTL_DAYS).toBe(1);
    expect(parseEnv(baseInput({ REFRESH_TOKEN_TTL_DAYS: '90' })).REFRESH_TOKEN_TTL_DAYS).toBe(90);
  });

  it('rejects REFRESH_TOKEN_TTL_DAYS outside the allowed window', () => {
    expect(() => parseEnv(baseInput({ REFRESH_TOKEN_TTL_DAYS: '0' }))).toThrow();
    expect(() => parseEnv(baseInput({ REFRESH_TOKEN_TTL_DAYS: '91' }))).toThrow();
  });

  it('keeps signature storage disabled by default with bounded PDF limits', () => {
    const env = parseEnv(baseInput());

    expect(env.SIGNATURE_STORAGE_PROVIDER).toBe('disabled');
    expect(env.SIGNATURE_MALWARE_SCANNER).toBe('disabled');
    expect(env.SIGNATURE_CLAMDSCAN_PATH).toBe('clamdscan');
    expect(env.SIGNATURE_MALWARE_SCAN_TIMEOUT_MS).toBe(30_000);
    expect(env.SIGNATURE_MAX_PDF_BYTES).toBe(25 * 1024 * 1024);
    expect(env.SIGNATURE_MAX_PDF_PAGES).toBe(200);
  });

  it('requires a root for local signature storage and rejects it in production', () => {
    expect(() => parseEnv(baseInput({ SIGNATURE_STORAGE_PROVIDER: 'filesystem' }))).toThrow();
    expect(() =>
      parseEnv(
        baseInput({
          NODE_ENV: 'production',
          SIGNATURE_STORAGE_PROVIDER: 'filesystem',
          SIGNATURE_FILESYSTEM_ROOT: '/private/signatures',
        }),
      ),
    ).toThrow();
    expect(
      parseEnv(
        baseInput({
          SIGNATURE_STORAGE_PROVIDER: 'filesystem',
          SIGNATURE_FILESYSTEM_ROOT: '/tmp/uoa-signatures',
        }),
      ).SIGNATURE_FILESYSTEM_ROOT,
    ).toBe('/tmp/uoa-signatures');
  });

  it('requires a bucket for GCS signature storage', () => {
    expect(() => parseEnv(baseInput({ SIGNATURE_STORAGE_PROVIDER: 'gcs' }))).toThrow();
    expect(
      parseEnv(
        baseInput({ SIGNATURE_STORAGE_PROVIDER: 'gcs', SIGNATURE_GCS_BUCKET: 'uoa-signatures' }),
      ).SIGNATURE_GCS_BUCKET,
    ).toBe('uoa-signatures');
  });

  it('accepts a dedicated evidence key pair and requires matching current kids', () => {
    const privateKey = JSON.stringify({
      kty: 'RSA',
      kid: 'evidence-2026-07',
      alg: 'RS256',
      use: 'sig',
      n: 'modulus',
      e: 'AQAB',
      d: 'private',
    });
    const publicKeys = JSON.stringify({
      keys: [
        {
          kty: 'RSA',
          kid: 'evidence-2026-07',
          alg: 'RS256',
          use: 'sig',
          n: 'modulus',
          e: 'AQAB',
        },
      ],
    });
    const env = parseEnv(
      baseInput({
        SIGNATURE_EVIDENCE_PRIVATE_JWK: privateKey,
        SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON: publicKeys,
      }),
    );
    expect(env.SIGNATURE_EVIDENCE_PRIVATE_JWK).toBe(privateKey);
    expect(env.SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON).toBe(publicKeys);

    expect(() =>
      parseEnv(
        baseInput({
          SIGNATURE_EVIDENCE_PRIVATE_JWK: privateKey,
          SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON: JSON.stringify({
            keys: [{ kty: 'RSA', kid: 'old', n: 'old', e: 'AQAB' }],
          }),
        }),
      ),
    ).toThrow();
  });

  it('rejects malformed, non-RS256, duplicate, and private evidence verification keys', () => {
    expect(() => parseEnv(baseInput({ SIGNATURE_EVIDENCE_PRIVATE_JWK: '{}' }))).toThrow();
    expect(() =>
      parseEnv(
        baseInput({
          SIGNATURE_EVIDENCE_PRIVATE_JWK: JSON.stringify({
            kty: 'RSA',
            kid: 'wrong-alg',
            alg: 'ES256',
            n: 'modulus',
            e: 'AQAB',
            d: 'private',
          }),
        }),
      ),
    ).toThrow();
    const publicKey = { kty: 'RSA', kid: 'duplicate', n: 'modulus', e: 'AQAB' };
    expect(() =>
      parseEnv(
        baseInput({
          SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [publicKey, publicKey] }),
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEnv(
        baseInput({
          SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON: JSON.stringify({
            keys: [{ ...publicKey, d: 'private' }],
          }),
        }),
      ),
    ).toThrow();
  });

  it('rejects unbounded signature PDF limits', () => {
    expect(() => parseEnv(baseInput({ SIGNATURE_MAX_PDF_BYTES: '512' }))).toThrow();
    expect(() => parseEnv(baseInput({ SIGNATURE_MAX_PDF_PAGES: '0' }))).toThrow();
    expect(() => parseEnv(baseInput({ SIGNATURE_MAX_PDF_PAGES: '2001' }))).toThrow();
    expect(() => parseEnv(baseInput({ SIGNATURE_MALWARE_SCAN_TIMEOUT_MS: '999' }))).toThrow();
    expect(() => parseEnv(baseInput({ SIGNATURE_MALWARE_SCAN_TIMEOUT_MS: '120001' }))).toThrow();
  });
});
