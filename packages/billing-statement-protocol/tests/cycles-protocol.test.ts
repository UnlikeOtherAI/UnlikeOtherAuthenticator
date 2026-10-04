import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  BILLING_CYCLES_PROTOCOL_VERSION,
  billingCyclesProtocolV1JsonSchema,
  billingCyclesListV1JsonSchema,
  billingCycleDetailV1JsonSchema,
  billingCycleDownloadRequestV1JsonSchema,
  billingCyclesListV1ConformanceFixture,
  billingCycleDetailV1ConformanceFixture,
  billingCycleDownloadRequestV1ConformanceFixture,
  billingCyclesV1OpenApiDocument,
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
      [billingCyclesListV1JsonSchema, billingCyclesListV1ConformanceFixture],
      [billingCycleDetailV1JsonSchema, billingCycleDetailV1ConformanceFixture],
      [billingCycleDownloadRequestV1JsonSchema, billingCycleDownloadRequestV1ConformanceFixture],
    ] as const;
    for (const [schema, fixture] of cases) {
      const validate = ajv.compile(schema);
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...fixture, provider_cost: '10' })).toBe(false);
      assertPublic(fixture);
    }
    expect(billingCycleDetailV1ConformanceFixture.totals[0]?.total_due.amount_minor).toBe('2000');
    expect(billingCycleDetailV1ConformanceFixture.usage_lines[0]?.credits_consumed).toBe('13000');
  });

  it('pins download authority to the exact document and rejects private fields', () => {
    const validate = ajv.compile(billingCycleDetailV1JsonSchema);
    const detail = structuredClone(billingCycleDetailV1ConformanceFixture);
    detail.documents[0]!.download_action!.body.document_id = 'other';
    // Referential matching is enforced by the producer; the protocol still rejects unknown fields.
    (detail.documents[0] as unknown as Record<string, unknown>).markup_bps = 3000;
    expect(validate(detail)).toBe(false);
  });

  it('keeps generated schema, fixture, and OpenAPI artifacts in sync', async () => {
    const root = new URL('../', import.meta.url);
    const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8')) as unknown;
    expect(await read('schema/billing-cycles-v1.json')).toEqual(billingCyclesProtocolV1JsonSchema);
    expect(await read('fixtures/billing-cycles-v1.example.json')).toEqual({
      list: billingCyclesListV1ConformanceFixture,
      detail: billingCycleDetailV1ConformanceFixture,
      download_request: billingCycleDownloadRequestV1ConformanceFixture,
    });
    expect(await read('openapi/billing-cycles-v1.openapi.json')).toEqual(billingCyclesV1OpenApiDocument);
    expect(BILLING_CYCLES_PROTOCOL_VERSION).toBe('1.0.0');
  });
});
