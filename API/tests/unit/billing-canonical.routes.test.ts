import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  billingConsumerActionV1ConformanceFixtures,
  billingStatementV2ConformanceFixture,
} from '../../src/contracts/billing-statement-v1.js';

const appKeyService = vi.hoisted(() => ({
  verifyBillingAppKey: vi.fn(),
}));
const statementService = vi.hoisted(() => ({
  getCanonicalBillingStatement: vi.fn(),
  getCanonicalBillingStatementV2: vi.fn(),
}));
const accessService = vi.hoisted(() => ({
  confirmAuthenticatedDirectBillingServiceAccess: vi.fn(),
}));
const previewService = vi.hoisted(() => ({
  createBillingCancellationPreview: vi.fn(),
}));
const confirmService = vi.hoisted(() => ({
  confirmBillingCancellation: vi.fn(),
}));

vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-app-key.service.js')
  >('../../src/services/billing-app-key.service.js');
  return { ...actual, ...appKeyService };
});
vi.mock('../../src/services/billing-statement.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-statement.service.js')
  >('../../src/services/billing-statement.service.js');
  return { ...actual, ...statementService };
});
vi.mock('../../src/services/billing-service-access.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-service-access.service.js')
  >('../../src/services/billing-service-access.service.js');
  return { ...actual, ...accessService };
});
vi.mock('../../src/services/billing-cancellation-preview.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-cancellation-preview.service.js')
  >('../../src/services/billing-cancellation-preview.service.js');
  return { ...actual, ...previewService };
});
vi.mock('../../src/services/billing-cancellation-confirm.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-cancellation-confirm.service.js')
  >('../../src/services/billing-cancellation-confirm.service.js');
  return { ...actual, ...confirmService };
});

const originalSharedSecret = process.env.SHARED_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
const credential = {
  id: 'app_key_1',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
};
const subject = {
  product: 'deepwater',
  organisation_id: 'org_1',
  team_id: 'team_1',
  user_id: 'user_1',
};

beforeAll(() => {
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
});

afterAll(() => {
  if (originalSharedSecret === undefined) {
    Reflect.deleteProperty(process.env, 'SHARED_SECRET');
  } else {
    process.env.SHARED_SECRET = originalSharedSecret;
  }
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  appKeyService.verifyBillingAppKey.mockResolvedValue(credential);
  statementService.getCanonicalBillingStatement.mockResolvedValue({
    schema_version: 1,
    statement_id: 'bst_1',
  });
  statementService.getCanonicalBillingStatementV2.mockResolvedValue(
    billingStatementV2ConformanceFixture,
  );
  accessService.confirmAuthenticatedDirectBillingServiceAccess.mockResolvedValue(undefined);
  previewService.createBillingCancellationPreview.mockResolvedValue(
    billingConsumerActionV1ConformanceFixtures.cancellation_preview,
  );
  confirmService.confirmBillingCancellation.mockResolvedValue(
    billingConsumerActionV1ConformanceFixtures.cancellation_confirmation,
  );
});

async function withApp(
  callback: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>,
): Promise<void> {
  const app = await createApp();
  await app.ready();
  try {
    await callback(app);
  } finally {
    await app.close();
  }
}

describe('canonical customer billing routes', () => {
  it('publishes the immutable statement schema without credentials', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: '/schemas/billing-statement-v1.json',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/schema+json');
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.json()).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'UOA canonical customer billing statement',
      });
    });
  });

  it('publishes the synthetic fixture and matching OpenAPI 3.1 component', async () => {
    await withApp(async (app) => {
      const [fixtureResponse, openApiResponse] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/schemas/billing-statement-v1.example.json',
        }),
        app.inject({
          method: 'GET',
          url: '/schemas/billing-statement-v1.openapi.json',
        }),
      ]);

      expect(fixtureResponse.statusCode).toBe(200);
      expect(fixtureResponse.headers['cache-control']).toBe('public, max-age=300');
      expect(fixtureResponse.json()).toMatchObject({
        schema_version: 1,
        statement_id: 'bst_conformance_v1',
      });

      expect(openApiResponse.statusCode).toBe(200);
      expect(openApiResponse.headers['cache-control']).toBe('public, max-age=300');
      expect(openApiResponse.json()).toMatchObject({
        openapi: '3.1.0',
        info: { version: '1.0.0' },
        components: {
          schemas: {
            BillingStatementV1: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
            },
          },
          examples: {
            BillingStatementV1Conformance: {
              value: {
                schema_version: 1,
                statement_id: 'bst_conformance_v1',
              },
            },
          },
        },
      });
    });
  });

  it('publishes the exact V2 portfolio schema, fixture, and OpenAPI component', async () => {
    await withApp(async (app) => {
      const [schemaResponse, fixtureResponse, openApiResponse] = await Promise.all([
        app.inject({ method: 'GET', url: '/schemas/billing-statement-v2.json' }),
        app.inject({ method: 'GET', url: '/schemas/billing-statement-v2.example.json' }),
        app.inject({ method: 'GET', url: '/schemas/billing-statement-v2.openapi.json' }),
      ]);

      expect(schemaResponse.statusCode).toBe(200);
      expect(schemaResponse.json()).toMatchObject({
        $id: '/schemas/billing-statement-v2.json',
        properties: {
          schema_version: { const: 2 },
          connected_service_usage: { additionalProperties: false },
        },
      });
      expect(fixtureResponse.statusCode).toBe(200);
      expect(fixtureResponse.json()).toMatchObject({
        schema_version: 2,
        statement_id: 'bst_conformance_v2',
        connected_service_usage: {
          statement_product: 'deepwater',
          services: [
            {
              billing_product: 'deepwater',
              origins: [
                expect.objectContaining({ product: 'deepwater' }),
                expect.objectContaining({ product: 'nessie' }),
              ],
            },
          ],
        },
      });
      expect(openApiResponse.statusCode).toBe(200);
      expect(openApiResponse.json()).toMatchObject({
        openapi: '3.1.0',
        info: { version: '2.0.0' },
        components: {
          schemas: { BillingStatementV2: { properties: { schema_version: { const: 2 } } } },
        },
      });
    });
  });

  it('publishes exact action schemas, synthetic fixtures, and OpenAPI components', async () => {
    await withApp(async (app) => {
      const [schemaResponse, fixtureResponse, openApiResponse] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/schemas/billing-consumer-actions-v1.json',
        }),
        app.inject({
          method: 'GET',
          url: '/schemas/billing-consumer-actions-v1.example.json',
        }),
        app.inject({
          method: 'GET',
          url: '/schemas/billing-consumer-actions-v1.openapi.json',
        }),
      ]);

      expect(schemaResponse.statusCode).toBe(200);
      expect(schemaResponse.headers['content-type']).toContain('application/schema+json');
      expect(schemaResponse.json()).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: {
          BillingCancellationPreviewV1: {
            additionalProperties: false,
            properties: {
              confirm_action: {
                additionalProperties: false,
                properties: {
                  method: { const: 'POST' },
                  path: { const: '/billing/v1/cancellation/confirm' },
                },
              },
            },
          },
        },
      });

      expect(fixtureResponse.statusCode).toBe(200);
      expect(fixtureResponse.json()).toMatchObject({
        hosted_redirect_response: {
          redirect_url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic',
        },
        cancellation_preview: {
          schema_version: 1,
          confirm_action: {
            method: 'POST',
            path: '/billing/v1/cancellation/confirm',
          },
        },
        cancellation_confirmation: {
          schema_version: 1,
          status: 'confirmed',
        },
        error: { error: 'billing_request_failed' },
      });

      expect(openApiResponse.statusCode).toBe(200);
      expect(openApiResponse.json()).toMatchObject({
        openapi: '3.1.0',
        components: {
          schemas: {
            BillingHostedRedirectResponse: { additionalProperties: false },
            BillingCancellationConfirmRequest: { additionalProperties: false },
            BillingErrorEnvelope: { additionalProperties: false },
          },
        },
      });
    });
  });

  it('binds a lifecycle key and actor to one statement subject and month', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/customer-statement',
        headers: {
          'x-uoa-app-key': 'uoa_app_product_key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: { ...subject, billing_month: '2026-07' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(statementService.getCanonicalBillingStatement).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        billingMonth: '2026-07',
        request: {
          product: 'deepwater',
          organisationId: 'org_1',
          teamId: 'team_1',
          userId: 'user_1',
        },
      });
    });
  });

  it('binds the V2 SSO-filled portfolio to the same exact lifecycle subject', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v2/customer-statement',
        headers: {
          'x-uoa-app-key': 'uoa_app_product_key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: { ...subject, billing_month: '2026-07' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual(billingStatementV2ConformanceFixture);
      expect(statementService.getCanonicalBillingStatementV2).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        billingMonth: '2026-07',
        request: {
          product: 'deepwater',
          organisationId: 'org_1',
          teamId: 'team_1',
          userId: 'user_1',
        },
      });
    });
  });

  it('fails closed when the V2 service returns a missing or locally extended field', async () => {
    const injectStatement = (app: Awaited<ReturnType<typeof createApp>>) =>
      app.inject({
        method: 'POST',
        url: '/billing/v2/customer-statement',
        headers: { 'x-uoa-app-key': 'uoa_app_product_key', 'x-uoa-actor': 'signed-actor' },
        payload: subject,
      });

    statementService.getCanonicalBillingStatementV2.mockResolvedValueOnce({
      schema_version: 2,
    });
    await withApp(async (app) => {
      const response = await injectStatement(app);
      expect(response.statusCode).toBe(500);
    });

    statementService.getCanonicalBillingStatementV2.mockResolvedValueOnce({
      ...billingStatementV2ConformanceFixture,
      locally_calculated_total: 'forbidden',
    });
    await withApp(async (app) => {
      const response = await injectStatement(app);
      expect(response.statusCode).toBe(500);
    });
  });

  it('records a direct product session through the product-bound lifecycle key', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/service-access/confirm',
        headers: {
          'x-uoa-app-key': 'uoa_app_product_key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: subject,
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toBe('');
      expect(accessService.confirmAuthenticatedDirectBillingServiceAccess).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: {
          product: 'deepwater',
          organisationId: 'org_1',
          teamId: 'team_1',
          userId: 'user_1',
        },
      });
    });
  });

  it('forwards only the frozen preview and confirmation inputs', async () => {
    await withApp(async (app) => {
      const preview = await app.inject({
        method: 'POST',
        url: '/billing/v1/cancellation/preview',
        headers: {
          'x-uoa-app-key': 'uoa_app_product_key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: subject,
      });
      expect(preview.statusCode).toBe(201);
      expect(previewService.createBillingCancellationPreview).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: {
          product: 'deepwater',
          organisationId: 'org_1',
          teamId: 'team_1',
          userId: 'user_1',
        },
      });

      const confirmation = await app.inject({
        method: 'POST',
        url: '/billing/v1/cancellation/confirm',
        headers: {
          'x-uoa-app-key': 'uoa_app_product_key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: {
          ...subject,
          preview_token: 'uoa_cancel_012345678901234567890123456789',
          idempotency_key: 'uoa_confirm_012345678901234567890123456789',
          selection: 'current_service',
        },
      });
      expect(confirmation.statusCode).toBe(200);
      expect(confirmService.confirmBillingCancellation).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: {
          product: 'deepwater',
          organisationId: 'org_1',
          teamId: 'team_1',
          userId: 'user_1',
        },
        token: 'uoa_cancel_012345678901234567890123456789',
        idempotencyKey: 'uoa_confirm_012345678901234567890123456789',
        selection: 'current_service',
      });
    });
  });

  it('rejects missing actor or entitlement-only keys before statement generation', async () => {
    await withApp(async (app) => {
      const noActor = await app.inject({
        method: 'POST',
        url: '/billing/v1/customer-statement',
        headers: { 'x-uoa-app-key': 'uoa_app_product_key' },
        payload: subject,
      });
      expect(noActor.statusCode).toBe(401);
    });
    appKeyService.verifyBillingAppKey.mockResolvedValueOnce({
      ...credential,
      purpose: BillingAppKeyPurpose.ENTITLEMENT,
      checkoutReturnOrigins: [],
    });
    await withApp(async (app) => {
      const wrongPurpose = await app.inject({
        method: 'POST',
        url: '/billing/v1/customer-statement',
        headers: {
          'x-uoa-app-key': 'uoa_app_entitlement_key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: subject,
      });
      expect(wrongPurpose.statusCode).toBe(403);
    });
    expect(statementService.getCanonicalBillingStatement).not.toHaveBeenCalled();
  });
});
