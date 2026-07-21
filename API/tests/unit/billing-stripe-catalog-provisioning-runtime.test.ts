import { describe, expect, it } from 'vitest';

import { resolveStripeCatalogDatabaseUrl } from '../../src/cli/stripe-catalog-provisioning-runtime.js';

describe('Stripe catalog provisioner runtime', () => {
  it('uses the admin database without requiring unrelated server configuration', () => {
    expect(
      resolveStripeCatalogDatabaseUrl({
        DATABASE_ADMIN_URL: 'postgresql://admin.example/catalog',
      }),
    ).toBe('postgresql://admin.example/catalog');
  });

  it('falls back to the ordinary database URL for local operation', () => {
    expect(
      resolveStripeCatalogDatabaseUrl({
        DATABASE_URL: 'postgresql://local.example/catalog',
      }),
    ).toBe('postgresql://local.example/catalog');
  });

  it('fails closed when neither documented database variable exists', () => {
    expect(() => resolveStripeCatalogDatabaseUrl({})).toThrow(
      'STRIPE_CATALOG_DATABASE_URL_REQUIRED',
    );
  });
});
