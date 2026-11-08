import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  billingAuthorityV1JsonSchema, billingCapabilitiesV2ConformanceFixtures,
  billingTeamOverviewV1ConformanceFixture, billingTeamOverviewRequestV1JsonSchema,
} from '../src/index.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(billingAuthorityV1JsonSchema);
const request = ajv.compile(billingTeamOverviewRequestV1JsonSchema);
describe('billing authority and own-team read-only records', () => {
  it('validates each authority verdict and the separate read-only overview', () => {
    for (const fixture of [...Object.values(billingCapabilitiesV2ConformanceFixtures),
      billingTeamOverviewV1ConformanceFixture]) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    }
  });
  it('never admits organisation financial scope in a team-reader or denied verdict', () => {
    for (const access of ['team_reader', 'none'] as const) {
      expect(validate({ ...billingCapabilitiesV2ConformanceFixtures[access],
        financial_scope: billingCapabilitiesV2ConformanceFixtures.organisation_manager.financial_scope })).toBe(false);
    }
  });
  it('requires a real non-null selected team in the reader verdict and request', () => {
    const fixture = structuredClone(billingCapabilitiesV2ConformanceFixtures.team_reader);
    expect(validate({ ...fixture, subject: { ...fixture.subject, team_id: null } })).toBe(false);
    expect(request(fixture.overview_request.body)).toBe(true);
    expect(request({ ...fixture.overview_request.body, team_id: null })).toBe(false);
    expect(request({ ...fixture.overview_request.body, financial_scope: 'organisation' })).toBe(false);
  });
  it('refuses a shared balance, subscription or money action on team records', () => {
    for (const extra of [{ balance: 0 }, { subscription: {} }, { actions: [] }, { total: 0 }]) {
      expect(validate({ ...billingTeamOverviewV1ConformanceFixture, ...extra })).toBe(false);
    }
  });
  it('keeps unconfirmed sections free of invented numeric data', () => {
    const fixture = structuredClone(billingTeamOverviewV1ConformanceFixture);
    for (const section of ['activity', 'recorded_credit_usage', 'retained_credits'] as const) {
      for (const state of ['pending_reconciliation', 'unavailable']) {
        const changed = { ...fixture, sections: { ...fixture.sections,
          [section]: { state, message: 'Records cannot be confirmed.', code: 'BILLING_TEAM_RECORDS_UNCONFIRMED' } } };
        expect(validate(changed), JSON.stringify(validate.errors)).toBe(true);
        changed.sections[section] = { ...changed.sections[section], data: {} } as never;
        expect(validate(changed)).toBe(false);
      }
    }
  });
  it('requires opaque captured-source provenance and an explicit mode per monetary record', () => {
    const fixture = structuredClone(billingTeamOverviewV1ConformanceFixture);
    const source = fixture.sections.recorded_credit_usage.data.sources[0];
    if (!source) throw new Error('Missing source fixture');
    source.source_ref = 'acct_provider';
    expect(validate(fixture)).toBe(false);
    source.source_ref = `tbs_${'a'.repeat(64)}`;
    (source as { mode: string }).mode = 'test';
    expect(validate(fixture)).toBe(false);
  });
});
