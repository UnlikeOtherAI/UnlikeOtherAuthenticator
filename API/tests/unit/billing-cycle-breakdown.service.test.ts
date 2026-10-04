import { readFile } from 'node:fs/promises';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { billingCycleDetailV2ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import {
  renderBillingCycleBreakdownCsv,
  renderBillingCycleBreakdownPdf,
  wrapCycleBreakdownText,
} from '../../src/services/billing-cycle-breakdown.service.js';

describe('frozen customer billing breakdown', () => {
  it('exports measured usage, seats, credits, and customer charges without private terms', async () => {
    const csv = renderBillingCycleBreakdownCsv(billingCycleDetailV2ConformanceFixture)
      .toString('utf8');
    expect(csv).toContain('"seat_interval"');
    expect(csv).toContain('"cached_input"');
    expect(csv).toContain('"13000"');
    expect(csv).toContain('"20"');
    expect(csv).toContain('"unit_price"');
    expect(csv).toContain('"seat_policy"');
    expect(csv).toContain('"total_paid"');
    expect(csv).toContain('"opening_balance"');
    expect(csv).not.toMatch(/markup|provider_cost|cost_basis|multiplier/i);

    const pdf = await renderBillingCycleBreakdownPdf(billingCycleDetailV2ConformanceFixture);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it('rejects a final PDF for an open preview', async () => {
    await expect(renderBillingCycleBreakdownPdf({
      ...billingCycleDetailV2ConformanceFixture, state: 'open_preview',
    })).rejects.toThrow('BILLING_CYCLE_PREVIEW_NOT_FINAL');
  });

  it('neutralizes control-prefixed spreadsheet formulas and fits long labels across pages',
    async () => {
      const longLabel = `=${'A'.repeat(240)}`;
      const detail = { ...billingCycleDetailV2ConformanceFixture,
        product: { ...billingCycleDetailV2ConformanceFixture.product,
          name: longLabel },
        usage_lines: Array.from({ length: 80 }, (_, index) => ({
          ...billingCycleDetailV2ConformanceFixture.usage_lines[0]!,
          id: `usage-${index}`, service_id: index === 0 ? `\n  ${longLabel}` : longLabel,
        })),
      };
      const csv = renderBillingCycleBreakdownCsv(detail).toString('utf8');
      expect(csv).toContain('"\'\n  =');
      expect(csv).toContain('"\'=' );
      const pdf = await renderBillingCycleBreakdownPdf(detail);
      expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
      const document = await PDFDocument.create();
      document.registerFontkit((await import('@pdf-lib/fontkit')).default);
      const font = await document.embedFont(await readFile(
        new URL('../../../assets/fonts/DejaVuSans.ttf', import.meta.url)));
      const wrapped = wrapCycleBreakdownText(longLabel, font, 9);
      expect(wrapped.length).toBeGreaterThan(1);
      expect(wrapped.every((line) => font.widthOfTextAtSize(line, 9) <= 511)).toBe(true);
    });
});
