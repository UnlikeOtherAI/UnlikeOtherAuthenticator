import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { billingOrganisationCapabilitiesV1ConformanceFixture as capability,
  billingOrganisationOverviewV1ConformanceFixture as overview } from '../src/organisation-overview-fixture.js';
import { billingOrganisationProtocolV1JsonSchema } from '../src/organisation-overview-schema.js';

const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
const validate = ajv.compile(billingOrganisationProtocolV1JsonSchema);
describe('organisation financial overview', () => {
  it('admits independent confirmed controls and balance while the bill is held without a numeric total', () => {
    expect(validate(capability), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(overview), JSON.stringify(validate.errors)).toBe(true);
  });
  it('refuses invented zero/partial totals on an unconfirmed bill', () => {
    for (const state of ['pending_reconciliation', 'unavailable']) {
      const altered = structuredClone(overview) as unknown as { sections: { accrued_bill: Record<string, unknown> } };
      altered.sections.accrued_bill.state = state;
      altered.sections.accrued_bill.data = { totals: [] };
      expect(validate(altered)).toBe(false);
    }
  });
  it('admits an ordinary-member false verdict without disclosing mode or financial data', () => {
    const { financial_scope: _scope, ...base } = capability;
    const denied = { ...base, capabilities: { can_view_billing: false, can_manage_billing: false } };
    expect(validate(denied)).toBe(true);
    expect(validate({ ...denied, financial_scope: _scope })).toBe(false);
  });
});
