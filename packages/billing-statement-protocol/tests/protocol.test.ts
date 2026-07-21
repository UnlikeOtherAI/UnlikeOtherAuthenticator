import { readFile } from 'node:fs/promises';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  BILLING_STATEMENT_PROTOCOL_VERSION,
  BILLING_STATEMENT_V2_PROTOCOL_VERSION,
  billingCancellationConfirmationV1JsonSchema,
  billingCancellationConfirmRequestJsonSchema,
  billingCancellationPreviewV1JsonSchema,
  billingConsumerActionProtocolV1JsonSchema,
  billingConsumerActionV1ConformanceFixtures,
  billingConsumerActionV1OpenApiDocument,
  billingErrorEnvelopeJsonSchema,
  billingHostedRedirectResponseJsonSchema,
  billingStatementV1ConformanceFixture,
  billingStatementV1JsonSchema,
  billingStatementV1OpenApiDocument,
  billingStatementV2ConformanceFixture,
  billingStatementV2JsonSchema,
  billingStatementV2OpenApiDocument,
} from '../src/index.js';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

describe('public BillingStatementV1 consumer protocol', () => {
  it('validates the conformance fixture against the exact Draft 2020-12 schema', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingStatementV1JsonSchema);

    expect(validate(billingStatementV1ConformanceFixture), JSON.stringify(validate.errors)).toBe(
      true,
    );
  });

  it('keeps generated JSON Schema, fixture, and OpenAPI 3.1 artifacts drift-free', async () => {
    const [schemaArtifact, fixtureArtifact, openApiArtifact] = await Promise.all([
      readJson('../schema/billing-statement-v1.json'),
      readJson('../fixtures/billing-statement-v1.example.json'),
      readJson('../openapi/billing-statement-v1.openapi.json'),
    ]);

    expect(schemaArtifact).toEqual(billingStatementV1JsonSchema);
    expect(fixtureArtifact).toEqual(billingStatementV1ConformanceFixture);
    expect(openApiArtifact).toEqual(billingStatementV1OpenApiDocument);
    expect(billingStatementV1OpenApiDocument.info.version).toBe(BILLING_STATEMENT_PROTOCOL_VERSION);
    expect(billingStatementV1OpenApiDocument.components.schemas.BillingStatementV1).toBe(
      billingStatementV1JsonSchema,
    );
    expect(
      billingStatementV1OpenApiDocument.components.examples.BillingStatementV1Conformance.value,
    ).toBe(billingStatementV1ConformanceFixture);
  });
});

describe('public BillingStatementV2 consumer protocol', () => {
  it('validates the SSO-filled portfolio fixture against the exact schema', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingStatementV2JsonSchema);

    expect(validate(billingStatementV2ConformanceFixture), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(
      validate({
        ...billingStatementV2ConformanceFixture,
        connected_service_usage: {
          ...billingStatementV2ConformanceFixture.connected_service_usage,
          locally_calculated_total: 'forbidden',
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...billingStatementV2ConformanceFixture,
        pinned_inputs: {
          ...billingStatementV2ConformanceFixture.pinned_inputs,
          ledger_snapshots: [
            {
              ...billingStatementV2ConformanceFixture.pinned_inputs.ledger_snapshots[0],
              group_by: 'service',
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it('keeps the V2 schema, fixture, and OpenAPI artifacts drift-free', async () => {
    const [schemaArtifact, fixtureArtifact, openApiArtifact] = await Promise.all([
      readJson('../schema/billing-statement-v2.json'),
      readJson('../fixtures/billing-statement-v2.example.json'),
      readJson('../openapi/billing-statement-v2.openapi.json'),
    ]);

    expect(schemaArtifact).toEqual(billingStatementV2JsonSchema);
    expect(fixtureArtifact).toEqual(billingStatementV2ConformanceFixture);
    expect(openApiArtifact).toEqual(billingStatementV2OpenApiDocument);
    expect(billingStatementV2OpenApiDocument.info.version).toBe(
      BILLING_STATEMENT_V2_PROTOCOL_VERSION,
    );
  });
});

describe('public billing consumer action protocol', () => {
  it('validates every synthetic fixture against its exact Draft 2020-12 schema', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validateProtocolMessage = ajv.compile(billingConsumerActionProtocolV1JsonSchema);
    const cases = [
      [
        billingHostedRedirectResponseJsonSchema,
        billingConsumerActionV1ConformanceFixtures.hosted_redirect_response,
      ],
      [
        billingCancellationPreviewV1JsonSchema,
        billingConsumerActionV1ConformanceFixtures.cancellation_preview,
      ],
      [
        billingCancellationConfirmRequestJsonSchema,
        billingConsumerActionV1ConformanceFixtures.cancellation_confirm_request,
      ],
      [
        billingCancellationConfirmationV1JsonSchema,
        billingConsumerActionV1ConformanceFixtures.cancellation_confirmation,
      ],
      [billingErrorEnvelopeJsonSchema, billingConsumerActionV1ConformanceFixtures.error],
    ] as const;

    for (const [schema, fixture] of cases) {
      const validate = ajv.compile(schema);
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
      expect(validateProtocolMessage(fixture), JSON.stringify(validateProtocolMessage.errors)).toBe(
        true,
      );
      expect(validate({ ...fixture, unexpected: true })).toBe(false);
    }
  });

  it('pins the confirmation action method/path and rejects protocol drift', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingCancellationPreviewV1JsonSchema);
    const fixture = billingConsumerActionV1ConformanceFixtures.cancellation_preview;

    expect(
      validate({
        ...fixture,
        confirm_action: { ...fixture.confirm_action, method: 'GET' },
      }),
    ).toBe(false);
    expect(
      validate({
        ...fixture,
        confirm_action: { ...fixture.confirm_action, path: '/billing/v1/cancellation/cancel' },
      }),
    ).toBe(false);
    expect(
      validate({
        ...fixture,
        confirm_action: { ...fixture.confirm_action, unexpected: true },
      }),
    ).toBe(false);
    expect(
      validate({
        ...fixture,
        choices: [{ ...fixture.choices[0], unexpected: true }, ...fixture.choices.slice(1)],
      }),
    ).toBe(false);
  });

  it('keeps generated action schema, fixtures, and OpenAPI artifacts drift-free', async () => {
    const [schemaArtifact, fixtureArtifact, openApiArtifact] = await Promise.all([
      readJson('../schema/billing-consumer-actions-v1.json'),
      readJson('../fixtures/billing-consumer-actions-v1.example.json'),
      readJson('../openapi/billing-consumer-actions-v1.openapi.json'),
    ]);

    expect(schemaArtifact).toEqual(billingConsumerActionProtocolV1JsonSchema);
    expect(fixtureArtifact).toEqual(billingConsumerActionV1ConformanceFixtures);
    expect(openApiArtifact).toEqual(billingConsumerActionV1OpenApiDocument);
    expect(billingConsumerActionV1OpenApiDocument.info.version).toBe(
      BILLING_STATEMENT_PROTOCOL_VERSION,
    );
  });
});
