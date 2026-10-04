import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  BILLING_CREDIT_PURCHASE_STATES,
  BILLING_CREDIT_PURCHASE_STATUS_PATH,
  billingCreditPurchaseStatusV1JsonSchema,
} from '../src/index.js';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

describe('localized credit purchase status protocol', () => {
  it('validates every state with required localized copy and rejects extra fields', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(billingCreditPurchaseStatusV1JsonSchema);
    for (const state of BILLING_CREDIT_PURCHASE_STATES) {
      expect(validate({
        schema_version: 1,
        purchase_id: 'purchase_1',
        state,
        title: 'Payment status',
        message: 'Payment message',
        awaiting_confirmation: state === 'processing',
      }), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate({
      schema_version: 1,
      purchase_id: 'purchase_1',
      state: 'failed',
      title: 'Payment failed',
      message: 'Return to payment to try again',
      awaiting_confirmation: false,
      continuation: {
        redirect_url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic',
        purchase_id: 'purchase_1',
      },
    }), JSON.stringify(validate.errors)).toBe(true);
    for (const continuation of [
      { redirect_url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic' },
      { redirect_url: 'https://checkout.stripe.com.evil.test/c/pay/x', purchase_id: 'purchase_1' },
      { redirect_url: 'http://checkout.stripe.com/c/pay/x', purchase_id: 'purchase_1' },
      { redirect_url: `https://checkout.stripe.com/${'x'.repeat(2100)}`, purchase_id: 'purchase_1' },
    ]) {
      expect(validate({
        schema_version: 1,
        purchase_id: 'purchase_1',
        state: 'open',
        title: 'Payment is open',
        message: 'Return to payment',
        awaiting_confirmation: false,
        continuation,
      })).toBe(false);
    }
    expect(BILLING_CREDIT_PURCHASE_STATUS_PATH).toBe('/billing/v1/credits/purchase-status');
    expect(validate({
      schema_version: 1,
      purchase_id: 'purchase_1',
      state: 'succeeded',
      title: 'Payment confirmed',
      message: 'Credits are ready',
      awaiting_confirmation: false,
      balance: '5000',
    })).toBe(false);
    expect(validate({
      schema_version: 1,
      purchase_id: 'purchase_1',
      state: 'unknown',
      title: 'Payment status',
      message: 'Payment message',
      awaiting_confirmation: false,
    })).toBe(false);
  });

  it('keeps the published JSON Schema artifact equal to its runtime schema', async () => {
    const schemaArtifact = await readJson('../schema/billing-credit-purchase-status-v1.json');
    expect(schemaArtifact).toEqual(billingCreditPurchaseStatusV1JsonSchema);
  });
});
