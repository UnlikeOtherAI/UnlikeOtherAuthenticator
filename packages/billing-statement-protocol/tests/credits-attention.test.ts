import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  BILLING_CREDIT_FUNDING_REQUEST_PATH,
  billingCreditFundingRequestV1JsonSchema,
  billingCreditsV1ConformanceFixture,
  billingCreditsV1JsonSchema,
  billingCreditsV1OpenApiDocument,
} from '../src/index.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateCredits = ajv.compile(billingCreditsV1JsonSchema);
const validateRequest = ajv.compile(billingCreditFundingRequestV1JsonSchema);

describe('negotiated billing attention and funding requests', () => {
  it('accepts legacy credits and the new safe source facts without recipient disclosure', () => {
    expect(validateCredits(billingCreditsV1ConformanceFixture)).toBe(true);
    const credits = {
      ...billingCreditsV1ConformanceFixture,
      attention: [{ event_key: 'opaque-event', kind: 'low_credits' }],
      funding_request: {
        label: 'Požádat o kredity', enabled: true, disabled_reason: null,
        request: { method: 'POST', path: BILLING_CREDIT_FUNDING_REQUEST_PATH,
          body: { product: 'nessie', organisation_id: 'org', team_id: 'team', user_id: 'user' } },
      },
    };
    expect(validateCredits(credits), JSON.stringify(validateCredits.errors)).toBe(true);
    expect(validateCredits({ ...credits, recipient_user_ids: ['manager'] })).toBe(false);
    expect(validateCredits({ ...credits, attention: [{ event_key: 'x', kind: 'unknown' }] })).toBe(false);
    expect(validateCredits({ ...credits, attention: [{ event_key: 'x', kind: 'low_credits', balance: 7 }] })).toBe(false);
  });

  it('keeps authorization results strict and separate from delivery claims', () => {
    const result = { schema_version: 1, request_id: 'request', recipient_user_ids: ['manager'] };
    expect(validateRequest(result)).toBe(true);
    expect(validateRequest({ ...result, recipient_user_ids: [] })).toBe(true);
    expect(validateRequest({ ...result, recipient_user_ids: ['manager', 'manager'] })).toBe(false);
    expect(validateRequest({ ...result, delivered: true })).toBe(false);
    expect(validateRequest({ ...result, request_id: '' })).toBe(false);
  });

  it('publishes the same strict result in the schema artifact and OpenAPI', async () => {
    const artifact = JSON.parse(await readFile(
      new URL('../schema/billing-credit-funding-request-v1.json', import.meta.url), 'utf8',
    ));
    expect(artifact).toEqual(billingCreditFundingRequestV1JsonSchema);
    expect(billingCreditsV1OpenApiDocument.paths[BILLING_CREDIT_FUNDING_REQUEST_PATH]
      .post.responses[200].content['application/json'].schema).toEqual(billingCreditFundingRequestV1JsonSchema);
  });
});
