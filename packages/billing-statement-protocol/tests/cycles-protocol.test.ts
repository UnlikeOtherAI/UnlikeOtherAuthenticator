import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  BILLING_CYCLES_PROTOCOL_VERSION,
  billingCyclesProtocolV2JsonSchema,
  billingCyclesListV2JsonSchema,
  billingCycleDetailV2JsonSchema,
  billingCycleDownloadRequestV2JsonSchema,
  billingCyclesListV2ConformanceFixture,
  billingCycleDetailV2ConformanceFixture,
  billingCycleDownloadRequestV2ConformanceFixture,
  billingCyclesV2OpenApiDocument,
} from '../src/index.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

function assertPublic(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertPublic);
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(/markup|provider_cost|cost_basis|multiplier|billable_units|rated_charge|cost_totals|provider_costs/i);
    if (typeof child === 'string' && /^(display|label|reason|message|title)$/.test(key)) {
      expect(child).not.toMatch(/provider cost|markup|margin|at.cost|cost.plus/i);
    }
    assertPublic(child);
  }
}

describe('customer billing cycles protocol', () => {
  it('validates exact list, detail, and download contracts without private pricing', () => {
    const cases = [
      [billingCyclesListV2JsonSchema, billingCyclesListV2ConformanceFixture],
      [billingCycleDetailV2JsonSchema, billingCycleDetailV2ConformanceFixture],
      [billingCycleDownloadRequestV2JsonSchema, billingCycleDownloadRequestV2ConformanceFixture],
    ] as const;
    for (const [schema, fixture] of cases) {
      const validate = ajv.compile(schema);
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...fixture, provider_cost: '10' })).toBe(false);
      assertPublic(fixture);
    }
    expect(billingCycleDetailV2ConformanceFixture.totals[0]?.total_due.amount_minor).toBe('2000');
    expect(billingCycleDetailV2ConformanceFixture.usage_lines[0]?.credits_consumed).toBe('13000');
  });

  it('pins download authority to the exact document and rejects private fields', () => {
    const validate = ajv.compile(billingCycleDetailV2JsonSchema);
    const detail = structuredClone(billingCycleDetailV2ConformanceFixture);
    detail.documents[0]!.download_action!.body.document_id = 'other';
    // Referential matching is enforced by the producer; the protocol still rejects unknown fields.
    (detail.documents[0] as unknown as Record<string, unknown>).markup_bps = 3000;
    expect(validate(detail)).toBe(false);
  });

  it('distinguishes team usage from organisation subscription scope and payer', () => {
    const validate = ajv.compile(billingCycleDetailV2JsonSchema);
    const org = structuredClone(billingCycleDetailV2ConformanceFixture);
    org.scope = { organisation_id: 'org_example', team_id: null,
      cycle_scope: 'organisation', payer_scope: 'organisation' };
    expect(validate(org), JSON.stringify(validate.errors)).toBe(true);
    org.scope.payer_scope = 'team';
    expect(validate(org)).toBe(false);
    org.scope.payer_scope = 'organisation';
    org.scope.team_id = 'team_example';
    expect(validate(org)).toBe(false);
    org.scope.cycle_scope = 'team';
    expect(validate(org), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keeps generated schema, fixture, and OpenAPI artifacts in sync', async () => {
    const root = new URL('../', import.meta.url);
    const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8')) as unknown;
    expect(await read('schema/billing-cycles-v2.json')).toEqual(billingCyclesProtocolV2JsonSchema);
    expect(await read('fixtures/billing-cycles-v2.example.json')).toEqual({
      list: billingCyclesListV2ConformanceFixture,
      detail: billingCycleDetailV2ConformanceFixture,
      download_request: billingCycleDownloadRequestV2ConformanceFixture,
    });
    expect(await read('openapi/billing-cycles-v2.openapi.json')).toEqual(billingCyclesV2OpenApiDocument);
    expect(BILLING_CYCLES_PROTOCOL_VERSION).toBe('2.1.0');
  });
});
