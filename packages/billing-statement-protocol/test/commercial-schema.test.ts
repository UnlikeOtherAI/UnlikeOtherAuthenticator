import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { productEntitlementV1JsonSchema } from '../src/commercial-schema.js';
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
