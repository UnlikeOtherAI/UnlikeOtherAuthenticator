import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { generateCreditPaymentInvoicePdf } from '../../src/services/billing-credit-payment-invoice-pdf.service.js';

const longText = Array.from({ length: 100 }, (_, index) => `RegisteredName${index}`).join(' ');

describe('prepaid legal PDF pagination', () => {
  it('continues unusually long legal parties before the charge table', async () => {
    const pdf = await generateCreditPaymentInvoicePdf({
      number: `PREPAID-${'A'.repeat(72)}`,
      issuedAt: new Date('2026-09-01T10:00:00.000Z'),
      paidAt: new Date('2026-08-31T23:59:58.000Z'),
      currency: 'USD',
      grossMinor: 500n,
      taxMinor: 83n,
      issuerSnapshot: {
        legal_name: longText,
        address: { line1: longText, city: 'London', postal_code: 'EC1A 1AA', country: 'GB' },
        billing_email: 'billing@example.test', tax_identifier: longText,
      },
      buyerSnapshot: {
        legal_name: longText,
        billing_address: {
          line1: longText, city: 'New York', postal_code: '10001', country: 'US',
        },
        billing_email: 'buyer@example.test', tax_identifier: longText,
      },
    });
    const document = await PDFDocument.load(pdf);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(document.getPages().every((page) => page.getWidth() > 590 &&
      page.getHeight() > 840)).toBe(true);
    const proofDir = process.env.BILLING_COLLECTION_PROOF_DIR;
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await writeFile(path.join(proofDir, 'prepaid-payment-invoice-long-party.pdf'), pdf);
    }
  });
});
