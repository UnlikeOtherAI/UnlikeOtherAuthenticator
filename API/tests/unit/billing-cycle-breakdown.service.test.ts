import { describe, expect, it } from 'vitest';

import { billingCycleDetailV1ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import {
  renderBillingCycleBreakdownCsv,
  renderBillingCycleBreakdownPdf,
} from '../../src/services/billing-cycle-breakdown.service.js';

describe('frozen customer billing breakdown', () => {
  it('exports measured usage, seats, credits, and customer charges without private terms', async () => {
    const csv = renderBillingCycleBreakdownCsv(billingCycleDetailV1ConformanceFixture)
      .toString('utf8');
    expect(csv).toContain('"seat_interval"');
    expect(csv).toContain('"cached_input"');
    expect(csv).toContain('"13000"');
    expect(csv).toContain('"20"');
    expect(csv).not.toMatch(/markup|provider_cost|cost_basis|multiplier/i);

    const pdf = await renderBillingCycleBreakdownPdf(billingCycleDetailV1ConformanceFixture);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it('rejects a final PDF for an open preview', async () => {
    await expect(renderBillingCycleBreakdownPdf({
      ...billingCycleDetailV1ConformanceFixture, state: 'open_preview',
    })).rejects.toThrow('BILLING_CYCLE_PREVIEW_NOT_FINAL');
  });
});
