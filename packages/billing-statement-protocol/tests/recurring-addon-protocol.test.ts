import { readFile } from 'node:fs/promises';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  BILLING_RECURRING_ADDONS_PROTOCOL_VERSION,
  billingRecurringAddonProtocolV1JsonSchema,
  billingRecurringAddonV1ConformanceFixtures,
  billingRecurringAddonV1OpenApiDocument,
} from '../src/index.js';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

describe('public recurring add-on consumer protocol', () => {
  it('validates every exact fixture and rejects unbounded context or zero monthly prices', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingRecurringAddonProtocolV1JsonSchema);

    for (const fixture of Object.values(billingRecurringAddonV1ConformanceFixtures)) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...fixture, unexpected: true })).toBe(false);
    }

    const zeroPrice = structuredClone(
      billingRecurringAddonV1ConformanceFixtures.recurring_addons,
    );
    zeroPrice.offers[0]!.monthly_price.amount = '0';
    expect(validate(zeroPrice)).toBe(false);

    const callerContext = structuredClone(
      billingRecurringAddonV1ConformanceFixtures.recurring_addons,
    );
    callerContext.offers[0]!.actions[0]!.request.body = {
      offer_id: 'rao_deepwater_privacy_v1',
      team_id: 'team_other',
    } as { offer_id: string };
    expect(validate(callerContext)).toBe(false);
  });

  it('never exposes manager entitlement identity or enabled actions to members', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingRecurringAddonProtocolV1JsonSchema);
    const member = billingRecurringAddonV1ConformanceFixtures.recurring_addons_member;
    const manager = billingRecurringAddonV1ConformanceFixtures.recurring_addons;

    expect(validate(member), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        ...member,
        viewer: { ...member.viewer, entitlement_visibility: 'full_team' },
        capabilities: { can_manage_addons: true },
      }),
    ).toBe(false);
    expect(
      validate({
        ...member,
        offers: [
          {
            ...member.offers[0],
            subscription: manager.offers[0]!.subscription,
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate({
        ...member,
        offers: [
          {
            ...member.offers[0],
            subscription: {
              ...member.offers[0]!.subscription,
              owner_user_id: 'usr_other',
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate({
        ...member,
        offers: [
          {
            ...member.offers[0],
            actions: [manager.offers[0]!.actions[1]],
          },
        ],
      }),
    ).toBe(false);
  });

  it('keeps generated add-on schema, fixtures, and OpenAPI artifacts drift-free', async () => {
    const [schemaArtifact, fixtureArtifact, openApiArtifact] = await Promise.all([
      readJson('../schema/billing-recurring-addons-v1.json'),
      readJson('../fixtures/billing-recurring-addons-v1.example.json'),
      readJson('../openapi/billing-recurring-addons-v1.openapi.json'),
    ]);

    expect(schemaArtifact).toEqual(billingRecurringAddonProtocolV1JsonSchema);
    expect(fixtureArtifact).toEqual(billingRecurringAddonV1ConformanceFixtures);
    expect(openApiArtifact).toEqual(billingRecurringAddonV1OpenApiDocument);
    expect(billingRecurringAddonV1OpenApiDocument.info.version).toBe(
      BILLING_RECURRING_ADDONS_PROTOCOL_VERSION,
    );
  });
});
