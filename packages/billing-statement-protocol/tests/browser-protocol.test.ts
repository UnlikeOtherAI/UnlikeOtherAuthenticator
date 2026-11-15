import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  billingBrowserReceiptRequestV1JsonSchema,
  billingBrowserReleaseRequestV1JsonSchema,
  billingBrowserReserveRequestV1JsonSchema,
} from '../src/browser-schema.js';
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const id = '00000000-0000-4000-8000-000000000001';
const read = { product: 'nessie', dispatch_id: id };
describe('browser financial wire boundary', () => {
  it('rejects content, client prices, missing attribution and unbounded sessions', () => {
    const validate = ajv.compile(billingBrowserReserveRequestV1JsonSchema);
    const body = {
      ...read,
      organisation_id: 'org',
      team_id: 'team',
      user_id: 'payer',
      project_id: id,
      max_duration_seconds: 1800,
      budget_context: null,
    };
    expect(validate(body)).toBe(true);
    expect(validate({ ...body, max_duration_seconds: 1801 })).toBe(false);
    expect(validate({ ...body, user_id: undefined })).toBe(false);
    expect(validate({ ...body, rate: '0.01' })).toBe(false);
  });
  it('accepts only bounded no-session proofs and rejects timeouts or absent proof', () => {
    const validate = ajv.compile(billingBrowserReleaseRequestV1JsonSchema);
    expect(validate({ ...read, proof: 'no_provider_dispatch' })).toBe(true);
    expect(validate({ ...read, proof: 'provider_rejected', provider_http_status: 429 })).toBe(true);
    expect(validate({ ...read, proof: 'provider_rejected', provider_http_status: 503 })).toBe(false);
    expect(validate({ ...read, proof: 'provider_rejected' })).toBe(false);
    expect(validate({ ...read, proof: 'no_provider_dispatch', provider_http_status: 429 })).toBe(false);
  });
  it('allows content-free terminal receipts only', () => {
    const validate = ajv.compile(billingBrowserReceiptRequestV1JsonSchema);
    const body = {
      ...read,
      project_id: id,
      session_id: id,
      status: 'COMPLETED',
      started_at: '2026-11-15T10:00:00.000Z',
      ended_at: '2026-11-15T10:01:00.001Z',
      proxy_bytes: 0,
    };
    expect(validate(body)).toBe(true);
    expect(validate({ ...body, status: 'RUNNING' })).toBe(false);
    expect(validate({ ...body, proxy_bytes: -1 })).toBe(false);
    expect(validate({ ...body, url: 'https://private.example.test' })).toBe(false);
    expect(validate({ ...body, amount: '1.00' })).toBe(false);
  });
});
