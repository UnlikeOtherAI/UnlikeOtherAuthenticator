import { readFile } from 'node:fs/promises';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { exactMoney, minorAmountToMajor } from './billing-money.service.js';

const TEMPLATE_VERSION = 'uoa-prepaid-payment-invoice-v1';
const REGULAR_FONT = new URL('../../../assets/fonts/DejaVuSans.ttf', import.meta.url);
const BOLD_FONT = new URL('../../../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url);
const WIDTH = 595.28;
const HEIGHT = 841.89;
const MARGIN = 48;

type Snapshot = Record<string, unknown>;
export type PaymentInvoicePdfInput = {
  number: string;
  issuedAt: Date;
  paidAt: Date;
  currency: string;
  grossMinor: bigint;
  taxMinor: bigint;
  issuerSnapshot: Snapshot;
  buyerSnapshot: Snapshot;
};

function clean(value: unknown): string {
  // Legal PDF text must not contain control bytes from mutable party records.
  return typeof value === 'string'
    // eslint-disable-next-line no-control-regex
    ? value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function address(snapshot: Snapshot, buyer: boolean): string[] {
  const raw = snapshot[buyer ? 'billing_address' : 'address'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const item = raw as Record<string, unknown>;
  return [item.line1, item.line2, item.city, item.region, item.postal_code, item.country]
    .map(clean).filter(Boolean);
}

function wrap(value: string, font: PDFFont, size: number, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of clean(value).split(' ')) {
    if (!word) continue;
    let part = '';
    for (const character of Array.from(word)) {
      if (part && font.widthOfTextAtSize(part + character, size) > max) {
        if (line) { lines.push(line); line = ''; }
        lines.push(part);
        part = character;
      } else {
        part += character;
      }
    }
    const next = line ? `${line} ${part}` : part;
    if (line && font.widthOfTextAtSize(next, size) > max) {
      lines.push(line);
      line = part;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function draw(page: PDFPage, font: PDFFont, value: string, x: number, y: number, size = 10) {
  page.drawText(clean(value), { x, y, font, size, color: rgb(0.12, 0.15, 0.2) });
}

function money(minor: bigint, currency: string): string {
  return exactMoney(minorAmountToMajor(minor.toString(), currency), currency).display;
}

function drawParty(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  title: string,
  snapshot: Snapshot,
  x: number,
  top: number,
  buyer: boolean,
) {
  const values = [
    clean(snapshot.legal_name),
    ...address(snapshot, buyer),
    clean(snapshot.billing_email),
    clean(snapshot.tax_identifier) ? `Tax ID: ${clean(snapshot.tax_identifier)}` : '',
  ].filter(Boolean);
  if (!values[0] || !values[1] || !values.some((item) => item.includes('@'))) {
    throw new Error('BILLING_CREDIT_PAYMENT_INVOICE_PARTY_INVALID');
  }
  draw(page, bold, title, x, top, 9);
  let y = top - 20;
  for (const [index, value] of values.entries()) {
    for (const line of wrap(value, index === 0 ? bold : regular, index === 0 ? 11 : 9, 225)) {
      draw(page, index === 0 ? bold : regular, line, x, y, index === 0 ? 11 : 9);
      y -= 14;
    }
  }
}

export async function generateCreditPaymentInvoicePdf(
  input: PaymentInvoicePdfInput,
): Promise<Uint8Array> {
  if (input.grossMinor <= 0n || input.taxMinor < 0n || input.taxMinor > input.grossMinor ||
      !input.number || !Number.isFinite(input.issuedAt.getTime())) {
    throw new Error('BILLING_CREDIT_PAYMENT_INVOICE_FACTS_INVALID');
  }
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(REGULAR_FONT), readFile(BOLD_FONT),
  ]);
  const regular = await document.embedFont(regularBytes, { subset: true });
  const bold = await document.embedFont(boldBytes, { subset: true });
  document.setTitle(`Invoice ${input.number}`);
  document.setAuthor(clean(input.issuerSnapshot.legal_name));
  document.setSubject('Prepaid credit purchase invoice');
  document.setCreator(TEMPLATE_VERSION);
  document.setProducer(TEMPLATE_VERSION);
  document.setCreationDate(input.issuedAt);
  document.setModificationDate(input.issuedAt);

  const page = document.addPage([WIDTH, HEIGHT]);
  draw(page, bold, 'INVOICE', MARGIN, 788, 22);
  draw(page, bold, input.number, MARGIN, 756, 12);
  draw(page, regular, `Issued: ${input.issuedAt.toISOString().slice(0, 10)} UTC`, MARGIN, 734, 9);
  draw(page, regular, `Paid: ${input.paidAt.toISOString().slice(0, 10)} UTC`, MARGIN, 718, 9);
  drawParty(page, regular, bold, 'ISSUED BY', input.issuerSnapshot, MARGIN, 676, false);
  drawParty(page, regular, bold, 'BILL TO', input.buyerSnapshot, 310, 676, true);
  page.drawLine({
    start: { x: MARGIN, y: 490 }, end: { x: WIDTH - MARGIN, y: 490 },
    thickness: 0.7, color: rgb(0.6, 0.65, 0.7),
  });
  draw(page, bold, 'Charge', MARGIN, 469, 10);
  draw(page, bold, 'Amount', 440, 469, 10);
  draw(page, regular, 'Prepaid credit purchase', MARGIN, 443, 10);
  draw(page, regular, money(input.grossMinor, input.currency), 440, 443, 10);
  const rows = [
    ['Subtotal before included tax', input.grossMinor - input.taxMinor],
    ['Included tax', input.taxMinor],
    ['Total charged', input.grossMinor],
    ['Paid', input.grossMinor],
    ['Outstanding', 0n],
  ] as const;
  let y = 389;
  for (const [label, value] of rows) {
    draw(page, label === 'Total charged' ? bold : regular, label, 290, y, 9);
    draw(page, label === 'Total charged' ? bold : regular, money(value, input.currency), 440, y, 9);
    y -= 23;
  }
  draw(page, regular, 'This invoice records the successful payment shown above.', MARGIN, 93, 8);
  draw(page, regular, 'Account usage and credit balances are documented separately.', MARGIN, 77, 8);
  return document.save({ useObjectStreams: false });
}
