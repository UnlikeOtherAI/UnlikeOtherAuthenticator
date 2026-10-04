import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { billingCreditBudgetV1ConformanceFixture, billingCreditBudgetV1JsonSchema,
  billingCreditBudgetV1OpenApiDocument, billingCreditBudgetWriteV1JsonSchema,
} from '../src/index.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

async function artifact(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(process.cwd(), path), 'utf8')) as unknown;
}

describe('public credit budgets', () => {
  it('exposes exact credit amounts without provider or token billing fields', () => {
    const validate = ajv.compile(billingCreditBudgetV1JsonSchema);
    expect(validate(billingCreditBudgetV1ConformanceFixture)).toBe(true);
    const forbidden = /raw_units|tokens|provider_cost|markup|surcharge|usd_equivalent/i;
    expect(JSON.stringify(billingCreditBudgetV1ConformanceFixture)).not.toMatch(forbidden);
    const polluted = structuredClone(billingCreditBudgetV1ConformanceFixture);
    (polluted.budgets[0] as unknown as Record<string, unknown>).raw_units = '10';
    expect(validate(polluted)).toBe(false);
  });

  it('validates bounded writes and rejects local token budgets', () => {
    const validate = ajv.compile(billingCreditBudgetWriteV1JsonSchema);
    const { budgets: [budget], product, organization_id, team_id } =
      billingCreditBudgetV1ConformanceFixture;
    if (!budget) throw new Error('Budget fixture missing');
    const write = { product, organization_id, team_id, scope_type: budget.scope_type,
      scope_id: budget.scope_id, period: budget.period, mode: budget.mode,
      limit_credits: budget.limit_credits, warn_threshold_percent: budget.warn_threshold_percent,
      block_humans_when_over: budget.block_humans_when_over,
      degrade_model: budget.degrade_model, degrade_provider: budget.degrade_provider };
    expect(validate(write)).toBe(true);
    expect(validate({ ...write, limit_credits: '1.0000001' })).toBe(false);
    expect(validate({ ...write, limit_tokens: '1000' })).toBe(false);
  });

  it('keeps generated public artifacts pinned to their source', async () => {
    expect(await artifact('schema/billing-credit-budgets-v1.json'))
      .toEqual(billingCreditBudgetV1JsonSchema);
    expect(await artifact('fixtures/billing-credit-budgets-v1.example.json'))
      .toEqual(billingCreditBudgetV1ConformanceFixture);
    expect(await artifact('openapi/billing-credit-budgets-v1.openapi.json'))
      .toEqual(billingCreditBudgetV1OpenApiDocument);
  });
});
