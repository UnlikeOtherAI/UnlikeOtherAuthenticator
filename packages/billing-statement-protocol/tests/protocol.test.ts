import { readFile } from 'node:fs/promises';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  BILLING_STATEMENT_PROTOCOL_VERSION,
  BILLING_STATEMENT_V2_PROTOCOL_VERSION,
  BILLING_CREDITS_PROTOCOL_VERSION,
  billingCancellationConfirmationV1JsonSchema,
  billingCancellationConfirmRequestJsonSchema,
  billingCancellationPreviewV1JsonSchema,
  billingConsumerActionProtocolV1JsonSchema,
  billingConsumerActionV1ConformanceFixtures,
  billingConsumerActionV1OpenApiDocument,
  billingErrorEnvelopeJsonSchema,
  billingHostedRedirectResponseJsonSchema,
  billingCreditsV1ConformanceFixture,
  billingCreditsV1JsonSchema,
  billingCreditsV1OpenApiDocument,
  billingStatementV1ConformanceFixture,
  billingStatementV1JsonSchema,
  billingStatementV1OpenApiDocument,
  billingStatementV2ConformanceFixture,
  billingStatementV2JsonSchema,
  billingStatementV2OpenApiDocument,
  type BillingCreditsManagerV1,
  type BillingCreditsMemberV1,
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

describe('public BillingCreditsV1 consumer protocol', () => {
  it('keeps the coordinated unreleased V1 contract version', () => {
    expect(BILLING_CREDITS_PROTOCOL_VERSION).toBe('1.0.0');
  });

  it('validates shared team credits, system adjustments, and fixed conversion', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingCreditsV1JsonSchema);

    expect(validate(billingCreditsV1ConformanceFixture), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(billingCreditsV1ConformanceFixture.conversion).toEqual({
      credits_per_usd: '1000',
      settlement_currency: 'USD',
      description: '1,000 credits always equal US$1.00; one cent always equals 10 credits.',
    });
    expect(
      billingCreditsV1ConformanceFixture.recent_entries.some(
        (entry) => entry.kind === 'adjustment' && entry.service === null,
      ),
    ).toBe(true);

    expect(
      validate({
        ...billingCreditsV1ConformanceFixture,
        conversion: {
          ...billingCreditsV1ConformanceFixture.conversion,
          credits_per_usd: '999',
        },
      }),
    ).toBe(false);
    expect(validate({ ...billingCreditsV1ConformanceFixture, wallet: {} })).toBe(false);
    expect(
      validate({
        ...billingCreditsV1ConformanceFixture,
        credit_balance: {
          ...billingCreditsV1ConformanceFixture.credit_balance,
          label: 'Credit balance',
        },
      }),
    ).toBe(false);
    expect(validate({ ...billingCreditsV1ConformanceFixture, balance_microcredits: '1' })).toBe(
      false,
    );
  });

  it('rejects zero positive prices, excess precision, and caller-controlled billing context', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingCreditsV1JsonSchema);

    const zeroPrice = structuredClone(billingCreditsV1ConformanceFixture);
    zeroPrice.funding_policy.offers[0]!.payment_amount.amount = '0';
    expect(validate(zeroPrice)).toBe(false);

    const precisionBoundary = structuredClone(billingCreditsV1ConformanceFixture);
    precisionBoundary.credit_balance.credits = '34125.00001';
    precisionBoundary.credit_balance.usd_equivalent.amount = '34.12500001';
    expect(validate(precisionBoundary), JSON.stringify(validate.errors)).toBe(true);

    const excessCreditPrecision = structuredClone(precisionBoundary);
    excessCreditPrecision.credit_balance.credits = '34125.000001';
    expect(validate(excessCreditPrecision)).toBe(false);

    const excessUsdPrecision = structuredClone(precisionBoundary);
    excessUsdPrecision.credit_balance.usd_equivalent.amount = '34.125000001';
    expect(validate(excessUsdPrecision)).toBe(false);

    const callerContext = structuredClone(billingCreditsV1ConformanceFixture);
    callerContext.funding_policy.offers[0]!.action!.request.body = {
      offer_id: 'cto_deepwater_20000',
      organisation_id: 'org_other',
    } as { offer_id: string };
    expect(validate(callerContext)).toBe(false);

    const disableBody = structuredClone(billingCreditsV1ConformanceFixture);
    disableBody.automatic_top_up.disable_action!.request = {
      ...disableBody.automatic_top_up.disable_action!.request,
      body: { team_id: 'team_other' },
    } as typeof disableBody.automatic_top_up.disable_action.request;
    expect(validate(disableBody)).toBe(false);
  });

  it('places complete frozen setup and update actions on every manager option', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingCreditsV1JsonSchema);
    const manager = billingCreditsV1ConformanceFixture as BillingCreditsManagerV1;

    for (const option of manager.automatic_top_up.options) {
      expect(option.setup_action.request.body.option_id).toBeTruthy();
      expect(option.update_action.request.body.option_id).toBe(
        option.setup_action.request.body.option_id,
      );
      expect(option.setup_action.request.body).toMatchObject({
        product: manager.storefront.identifier,
        organisation_id: manager.subject.organisation_id,
        team_id: manager.subject.team_id,
        user_id: manager.subject.user_id,
      });
    }

    const missingAction = structuredClone(manager);
    Reflect.deleteProperty(missingAction.automatic_top_up.options[0]!, 'update_action');
    expect(validate(missingAction)).toBe(false);

    const incompleteBody = structuredClone(manager);
    incompleteBody.automatic_top_up.options[0]!.setup_action.request.body = {
      option_id: 'option_other',
    } as (typeof incompleteBody.automatic_top_up.options)[0]['setup_action']['request']['body'];
    expect(validate(incompleteBody)).toBe(false);
  });

  it('pins credit offer and option selectors to 256 characters', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingCreditsV1JsonSchema);
    const accepted = structuredClone(billingCreditsV1ConformanceFixture);
    accepted.funding_policy.offers[0]!.action.request.body.offer_id = 'x'.repeat(256);
    accepted.automatic_top_up.options[0]!.setup_action.request.body.option_id = 'x'.repeat(256);
    accepted.automatic_top_up.options[0]!.update_action.request.body.option_id = 'x'.repeat(256);
    expect(validate(accepted), JSON.stringify(validate.errors)).toBe(true);

    const longOffer = structuredClone(accepted);
    longOffer.funding_policy.offers[0]!.action.request.body.offer_id = 'x'.repeat(257);
    expect(validate(longOffer)).toBe(false);
    const longOption = structuredClone(accepted);
    longOption.automatic_top_up.options[0]!.setup_action.request.body.option_id = 'x'.repeat(257);
    expect(validate(longOption)).toBe(false);
  });

  it('makes ordinary-member usage and funding projections structurally privacy-safe', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingCreditsV1JsonSchema);
    const manager = billingCreditsV1ConformanceFixture as BillingCreditsManagerV1;
    const zeroCredits = {
      credits: '0',
      display: '0 credits',
      usd_equivalent: { amount: '0', currency: 'USD' as const, display: 'US$0.00' },
    };
    const member = {
      ...manager,
      viewer: {
        role: 'member',
        usage_visibility: 'own_plus_team_aggregate',
        description: 'This viewer sees their usage plus anonymous team aggregates.',
      },
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
      credit_summary: {
        ...manager.credit_summary,
        consumed_breakdown: manager.credit_summary.consumed_breakdown.map((service) => ({
          service: service.service,
          credits_consumed: service.credits_consumed,
          viewer_credits_consumed:
            service.users.find((user) => user.user_id === manager.subject.user_id)
              ?.credits_consumed ?? zeroCredits,
          other_team_members_credits_consumed:
            service.users.find((user) => user.user_id !== manager.subject.user_id)
              ?.credits_consumed ?? zeroCredits,
          unattributed_credits_consumed: service.unattributed_credits_consumed,
        })),
      },
      pending_credits: { ...manager.pending_credits, payment_amount: null },
      funding_policy: null,
      automatic_top_up: {
        payment_method: { status: manager.automatic_top_up.payment_method.status },
      },
      recent_entries: manager.recent_entries.map(({ attribution, ...entry }) => ({
        ...entry,
        attribution:
          attribution.kind === 'user'
            ? attribution.user_id === manager.subject.user_id
              ? 'viewer'
              : 'other_team_members'
            : attribution.kind,
      })),
    } as unknown as BillingCreditsMemberV1;

    expect(validate(member), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...member, credit_summary: manager.credit_summary })).toBe(false);
    expect(validate({ ...member, recent_entries: [manager.recent_entries[1]] })).toBe(false);
    expect(
      validate({
        ...member,
        recent_entries: [
          {
            ...member.recent_entries[0],
            attribution: { kind: 'user', user_id: 'usr_other', display_name: 'Other' },
          },
        ],
      }),
    ).toBe(false);
    expect(validate({ ...member, pending_credits: manager.pending_credits })).toBe(false);
    expect(validate({ ...member, funding_policy: manager.funding_policy })).toBe(false);
    expect(
      validate({
        ...member,
        automatic_top_up: {
          ...member.automatic_top_up,
          threshold: manager.automatic_top_up.threshold,
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...member,
        automatic_top_up: {
          ...member.automatic_top_up,
          payment_method: manager.automatic_top_up.payment_method,
        },
      }),
    ).toBe(false);
  });

  it('keeps generated credit schema, fixture, and OpenAPI artifacts drift-free', async () => {
    const [schemaArtifact, fixtureArtifact, openApiArtifact] = await Promise.all([
      readJson('../schema/billing-credits-v1.json'),
      readJson('../fixtures/billing-credits-v1.example.json'),
      readJson('../openapi/billing-credits-v1.openapi.json'),
    ]);

    expect(schemaArtifact).toEqual(billingCreditsV1JsonSchema);
    expect(fixtureArtifact).toEqual(billingCreditsV1ConformanceFixture);
    expect(openApiArtifact).toEqual(billingCreditsV1OpenApiDocument);
    expect(billingCreditsV1OpenApiDocument.info.version).toBe(BILLING_CREDITS_PROTOCOL_VERSION);
  });
});
