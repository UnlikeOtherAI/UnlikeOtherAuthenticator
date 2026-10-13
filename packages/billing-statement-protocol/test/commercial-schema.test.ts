import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { productEntitlementV1JsonSchema, phoneReleaseVerdictV1JsonSchema } from '../src/commercial-schema.js';
import { productEntitlementMemberV1Fixture } from '../src/commercial-fixture.js';

describe('commercial entitlement privacy', () => {
  const ajv = new Ajv({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(productEntitlementV1JsonSchema);
  it('accepts functional member access while rejecting private commercial facts', () => {
    expect(validate(productEntitlementMemberV1Fixture)).toBe(true);
    for (const leak of [{ standing: 'private_at_cost' }, { standing: 'grace' },
      { dunning: null }, { platform_fees_waived: true }, { third_party_costs_payable: true }]) {
      expect(validate({ ...productEntitlementMemberV1Fixture, ...leak })).toBe(false);
    }
  });
  it('requires exact human subject and keeps recovery on the manager branch', () => {
    expect(validate({ ...productEntitlementMemberV1Fixture, subject: null })).toBe(false);
    expect(validate({ ...productEntitlementMemberV1Fixture, viewer: 'manager',
      standing: 'free', platform_fees_waived: false, third_party_costs_payable: true,
      dunning: null })).toBe(true);
  });
});

describe('phone release proof', () => {
  const ajv = new Ajv({ strict: true }); addFormats(ajv);
  const validate = ajv.compile(phoneReleaseVerdictV1JsonSchema);
  const proof = { schema_version: 1, product: 'nessie', organisation_id: 'company', incident_id: 'incident',
    resource_id: 'number', authorized: true, account_sid: `AC${'a'.repeat(32)}`,
    phone_number_sid: `PN${'b'.repeat(32)}`, valid_until: '2026-10-13T14:00:10.000Z' };
  it('requires complete exact provider identities in an authorized verdict', () => {
    expect(validate(proof)).toBe(true);
    expect(validate({ ...proof, account_sid: null })).toBe(false);
    expect(validate({ ...proof, phone_number_sid: 'another-number' })).toBe(false);
    expect(validate({ ...proof, resource_id: '' })).toBe(false);
  });
  it('never carries executable provider identities in a refused verdict', () => {
    expect(validate({ ...proof, authorized: false })).toBe(false);
    expect(validate({ ...proof, authorized: false, account_sid: null, phone_number_sid: null })).toBe(true);
  });
});
