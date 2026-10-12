import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  BILLING_ORG_BILLING_MANAGE_ACTION_ID,
  billingControlledByJsonSchema,
  billingCreditsV1ConformanceFixture,
  billingCreditsV1JsonSchema,
  billingStatementV1ConformanceFixture,
  billingStatementV1JsonSchema,
  billingStatementV2ConformanceFixture,
  billingStatementV2JsonSchema,
  billingRegionSetRequestV1JsonSchema,
  billingRegionViewV1JsonSchema,
} from '../src/index.js';

describe('organisation billing responsibility (protocol 1.3.0)', () => {
  const controlledByManager = {
    scope: 'organisation',
    organisation_id: 'org_synthetic',
    organisation_name: 'Acme',
    message: 'Billing for this team is managed for the whole organisation.',
    can_manage: true,
    manage_action_id: BILLING_ORG_BILLING_MANAGE_ACTION_ID,
  } as const;
  const controlledByMember = { ...controlledByManager, can_manage: false, manage_action_id: null };

  it('accepts both viewer shapes and rejects a fabricated manage action', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingControlledByJsonSchema);

    expect(validate(controlledByManager), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(controlledByMember), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...controlledByManager, manage_action_id: 'org-billing-transfer' })).toBe(
      false,
    );
    expect(validate({ ...controlledByManager, scope: 'team' })).toBe(false);
    expect(validate({ ...controlledByManager, unexpected: true })).toBe(false);
  });

  it('is optional on the statement and the credits view, so 1.2.0 payloads stay valid', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validateStatement = ajv.compile(billingStatementV1JsonSchema);
    const validateCredits = ajv.compile(billingCreditsV1JsonSchema);

    expect(validateStatement(billingStatementV1ConformanceFixture)).toBe(true);
    expect(
      validateStatement({
        ...billingStatementV1ConformanceFixture,
        controlled_by: controlledByMember,
        actions: [],
        capabilities: { can_upgrade: false, can_open_portal: false, can_cancel: false },
      }),
      JSON.stringify(validateStatement.errors),
    ).toBe(true);

    expect(validateCredits(billingCreditsV1ConformanceFixture)).toBe(true);
    expect(
      validateCredits({ ...billingCreditsV1ConformanceFixture, controlled_by: controlledByMember }),
      JSON.stringify(validateCredits.errors),
    ).toBe(true);
  });

  it('carries the organisation roll-up only on V2, with per-team pinned snapshots', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingStatementV2JsonSchema);
    const organisationScope = {
      organisation_id: 'org_synthetic',
      organisation_name: 'Acme',
      title: 'Organisation billing',
      description: 'Every team in Acme, billed together.',
      teams: [
        {
          team_id: 'team_synthetic',
          team_name: 'Research',
          display_name: 'Research',
          pinned_ledger_snapshot:
            billingStatementV2ConformanceFixture.pinned_inputs.ledger_snapshots[0],
          commercial_lines: billingStatementV2ConformanceFixture.commercial_lines,
          totals: billingStatementV2ConformanceFixture.totals,
        },
      ],
      commercial_lines: billingStatementV2ConformanceFixture.commercial_lines,
      totals: billingStatementV2ConformanceFixture.totals,
    };

    expect(
      validate({
        ...billingStatementV2ConformanceFixture,
        controlled_by: controlledByManager,
        organisation_scope: organisationScope,
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(
      validate({
        ...billingStatementV2ConformanceFixture,
        organisation_scope: { ...organisationScope, locally_calculated_total: 'forbidden' },
      }),
    ).toBe(false);
  });
});

describe('organisation billing region (protocol 5.3.0)', () => {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  it('carries a null region until chosen, with a prefill, and only the three regions and currencies', () => {
    const view = ajv.compile(billingRegionViewV1JsonSchema);
    expect(view({ region: null, currency: null, suggested_region: 'EUROPE', suggested_currency: 'EUR', can_set: true })).toBe(true);
    expect(view({ region: 'UK', currency: 'GBP', suggested_region: 'UK', suggested_currency: 'GBP', can_set: false })).toBe(true);
    expect(view({ region: 'APAC', currency: null, suggested_region: 'US', suggested_currency: 'USD', can_set: true })).toBe(false);
    expect(view({ region: null, currency: null, suggested_region: 'US', suggested_currency: 'USD' })).toBe(false);
  });
  it('sets the region with the ordinary subject fields only', () => {
    const set = ajv.compile(billingRegionSetRequestV1JsonSchema);
    const body = { product: 'nessie', organisation_id: 'org', team_id: 'team', user_id: 'user', region: 'US' };
    expect(set(body)).toBe(true);
    expect(set({ ...body, region: 'EU' })).toBe(false);
    expect(set({ ...body, currency: 'USD' })).toBe(false);
  });
});

