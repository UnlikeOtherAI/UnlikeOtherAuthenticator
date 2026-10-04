import { readFile } from 'node:fs/promises';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { currencyMinorDigits, minorAmountToMajor } from './billing-money.service.js';

const WIDTH = 595;
const HEIGHT = 842;
const MARGIN = 48;
const REGULAR = new URL('../../../assets/fonts/DejaVuSans.ttf', import.meta.url);
const BOLD = new URL('../../../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url);

export type ManualCreditNotePdf = {
  number: string;
  issuedAt: Date;
  originalInvoiceNumber: string;
  billingMonth: string;
  currency: string;
  netMinor: bigint;
  taxMinor: bigint;
  issuerSnapshot: Record<string, unknown>;
  buyerSnapshot: Record<string, unknown>;
};

function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.normalize('NFC'), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim();
}

function address(source: Record<string, unknown>, buyer: boolean): string[] {
  const raw = source[buyer ? 'billing_address' : 'address'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const row = raw as Record<string, unknown>;
  return [row.line1, row.line2, row.city, row.region, row.postal_code, row.country]
    .map(clean).filter(Boolean);
}

function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of clean(value).split(' ').filter(Boolean)) {
    let part = '';
    for (const glyph of Array.from(word)) {
      if (part && font.widthOfTextAtSize(part + glyph, size) > width) {
        if (current) { lines.push(current); current = ''; }
        lines.push(part);
        part = glyph;
      } else part += glyph;
    }
    const next = current ? `${current} ${part}` : part;
    if (current && font.widthOfTextAtSize(next, size) > width) {
      lines.push(current);
      current = part;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function draw(page: PDFPage, font: PDFFont, value: string, x: number, y: number,
  size = 10): void {
  page.drawText(clean(value), { x, y, size, font,
    color: rgb(0.13, 0.17, 0.22) });
}

function drawLines(page: PDFPage, font: PDFFont, rows: string[], x: number,
  top: number, width: number): number {
  let y = top;
  for (const row of rows) {
    for (const line of wrap(row, font, 9, width)) {
      if (y < 250) throw new Error('BILLING_CREDIT_NOTE_PARTY_TOO_LONG');
      draw(page, font, line, x, y, 9);
      y -= 14;
    }
  }
  return y;
}

function party(source: Record<string, unknown>, buyer: boolean): string[] {
  const name = clean(source.legal_name);
  const email = clean(source.billing_email);
  const location = address(source, buyer);
  if (!name || !email || !location.length) {
    throw new Error('BILLING_CREDIT_NOTE_PARTY_INVALID');
  }
  const taxId = clean(source.tax_identifier);
  return [name, ...location, email, ...(taxId ? [`Tax ID ${taxId}`] : [])];
}

function money(minor: bigint, currency: string): string {
  const [whole, fraction = ''] = minorAmountToMajor(minor.toString(), currency).split('.');
  const decimals = currencyMinorDigits(currency);
  return `${whole?.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${
    decimals ? `.${fraction.padEnd(decimals, '0')}` : ''} ${currency}`;
}

/** A separate legal credit note for a proven reduction, never a negative
 * invoice or a fabricated wallet refund. Only customer charge facts render. */
export async function renderManualCreditNotePdf(input: ManualCreditNotePdf): Promise<Buffer> {
  if (input.netMinor <= 0n || input.taxMinor < 0n ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.billingMonth) ||
    !Number.isFinite(input.issuedAt.valueOf())) {
    throw new Error('BILLING_CREDIT_NOTE_AMOUNT_INVALID');
  }
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const [regular, bold] = await Promise.all([
    readFile(REGULAR).then((bytes) => document.embedFont(bytes)),
    readFile(BOLD).then((bytes) => document.embedFont(bytes)),
  ]);
  const page = document.addPage([WIDTH, HEIGHT]);
  draw(page, bold, 'CREDIT NOTE', MARGIN, HEIGHT - MARGIN, 20);
  draw(page, regular, `Credit note ${input.number}`, MARGIN, HEIGHT - 90, 10);
  draw(page, regular, `Issued ${input.issuedAt.toISOString().slice(0, 10)}`,
    MARGIN, HEIGHT - 107, 10);
  draw(page, regular, `Corrects invoice ${input.originalInvoiceNumber}`,
    MARGIN, HEIGHT - 124, 10);
  draw(page, regular, `Billing month ${input.billingMonth}`,
    MARGIN, HEIGHT - 141, 10);
  draw(page, bold, 'Issued by', MARGIN, HEIGHT - 185, 10);
  draw(page, bold, 'Issued to', WIDTH / 2 + 12, HEIGHT - 185, 10);
  const issuerBottom = drawLines(page, regular, party(input.issuerSnapshot, false),
    MARGIN, HEIGHT - 205, 225);
  const buyerBottom = drawLines(page, regular, party(input.buyerSnapshot, true),
    WIDTH / 2 + 12, HEIGHT - 205, 225);
  const chargeTop = Math.min(issuerBottom, buyerBottom) - 28;
  if (chargeTop < 190) throw new Error('BILLING_CREDIT_NOTE_PARTY_TOO_LONG');
  page.drawLine({ start: { x: MARGIN, y: chargeTop },
    end: { x: WIDTH - MARGIN, y: chargeTop }, thickness: 1,
    color: rgb(0.55, 0.6, 0.66) });
  draw(page, bold, 'Cancellation of original invoice charges',
    MARGIN, chargeTop - 24, 10);
  draw(page, regular, `Net credit ${money(input.netMinor, input.currency)}`,
    MARGIN, chargeTop - 48, 10);
  draw(page, regular, `Tax credit ${money(input.taxMinor, input.currency)}`,
    MARGIN, chargeTop - 68, 10);
  draw(page, bold, `Total credit ${money(input.netMinor + input.taxMinor,
    input.currency)}`, MARGIN, chargeTop - 94, 12);
  draw(page, regular, 'This credit note adjusts the original invoice. It is not a cash refund.',
    MARGIN, 58, 8);
  return Buffer.from(await document.save());
}
