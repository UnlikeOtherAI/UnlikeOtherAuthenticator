import { readFile } from 'node:fs/promises';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { exactMoney, minorAmountToMajor } from './billing-money.service.js';
import type { CustomerSafeInvoice } from './billing-invoice-view.service.js';

const TEMPLATE_VERSION = 'uoa-contract-invoice-v2';
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const BODY_BOTTOM = 76;
const REGULAR_FONT = new URL('../../../assets/fonts/DejaVuSans.ttf', import.meta.url);
const BOLD_FONT = new URL('../../../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url);

type Party = {
  legalName: string;
  email: string;
  address: string[];
  taxIdentifier: string | null;
  registration: string | null;
  purchaseOrder: string | null;
};

type RenderContext = {
  document: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  invoiceNumber: string;
  y: number;
};

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const printable = Array.from(value.normalize('NFC'), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13) return ' ';
    if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) return '';
    return character;
  }).join('');
  return printable
    .replace(/\s+/g, ' ')
    .trim();
}

function snapshot(value: unknown, buyer: boolean): Party {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const addressValue = source[buyer ? 'billing_address' : 'address'];
  const address =
    addressValue && typeof addressValue === 'object' && !Array.isArray(addressValue)
      ? (addressValue as Record<string, unknown>)
      : {};
  const party = {
    legalName: cleanText(source.legal_name),
    email: cleanText(source.billing_email),
    address: [
      address.line1,
      address.line2,
      address.city,
      address.region,
      address.postal_code,
      address.country,
    ]
      .map(cleanText)
      .filter(Boolean),
    taxIdentifier: cleanText(source.tax_identifier) || null,
    registration: cleanText(source.company_registration_number) || null,
    purchaseOrder: cleanText(source.purchase_order_reference) || null,
  };
  if (!party.legalName || !party.email) {
    throw new Error('BILLING_INVOICE_PDF_PARTY_INVALID');
  }
  return party;
}

function displayMinor(amount: bigint, currency: string): string {
  return exactMoney(minorAmountToMajor(amount.toString(), currency), currency).display;
}

function drawAt(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  size = 10,
): void {
  page.drawText(cleanText(text), { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
}

function breakWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const character of Array.from(word)) {
    if (piece && font.widthOfTextAtSize(piece + character, size) > maxWidth) {
      pieces.push(piece);
      piece = character;
    } else {
      piece += character;
    }
  }
  if (piece) pieces.push(piece);
  return pieces.length ? pieces : [''];
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words.flatMap((item) => breakWord(item, font, size, maxWidth))) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function startContinuationPage(context: RenderContext): void {
  context.page = context.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawAt(context.page, context.bold, `Invoice ${context.invoiceNumber}`, MARGIN, 790, 11);
  context.y = 758;
}

function ensureSpace(context: RenderContext, height: number): boolean {
  if (context.y - height >= BODY_BOTTOM) return false;
  startContinuationPage(context);
  return true;
}

function drawFlowLines(
  context: RenderContext,
  value: string,
  options?: { font?: PDFFont; size?: number; width?: number; indent?: number },
): void {
  const font = options?.font ?? context.font;
  const size = options?.size ?? 9;
  const width = options?.width ?? PAGE_WIDTH - MARGIN * 2;
  const indent = options?.indent ?? 0;
  const lineHeight = size + 4;
  for (const line of wrapText(value, font, size, width)) {
    ensureSpace(context, lineHeight);
    drawAt(context.page, font, line, MARGIN + indent, context.y, size);
    context.y -= lineHeight;
  }
}

function drawParty(context: RenderContext, title: string, party: Party): void {
  ensureSpace(context, 30);
  drawAt(context.page, context.bold, title, MARGIN, context.y, 9);
  context.y -= 18;
  drawFlowLines(context, party.legalName, { font: context.bold, size: 11 });
  for (const line of party.address) drawFlowLines(context, line);
  drawFlowLines(context, party.email);
  if (party.registration) drawFlowLines(context, `Registration: ${party.registration}`);
  if (party.taxIdentifier) drawFlowLines(context, `Tax ID: ${party.taxIdentifier}`);
  if (party.purchaseOrder) drawFlowLines(context, `Purchase order: ${party.purchaseOrder}`);
  context.y -= 10;
}

function drawTableHeader(context: RenderContext): void {
  ensureSpace(context, 24);
  drawAt(context.page, context.bold, 'Service', MARGIN, context.y, 9);
  const price = 'Final price';
  drawAt(
    context.page,
    context.bold,
    price,
    PAGE_WIDTH - MARGIN - context.bold.widthOfTextAtSize(price, 9),
    context.y,
    9,
  );
  context.y -= 16;
  context.page.drawLine({
    start: { x: MARGIN, y: context.y + 7 },
    end: { x: PAGE_WIDTH - MARGIN, y: context.y + 7 },
    thickness: 0.5,
    color: rgb(0.55, 0.55, 0.55),
  });
}

function drawServiceLines(context: RenderContext, invoice: CustomerSafeInvoice): void {
  drawTableHeader(context);
  for (const line of [...invoice.lines].sort((a, b) => a.position - b.position)) {
    const label = `${line.serviceName} (${line.serviceIdentifier})`;
    const nameLines = wrapText(label, context.font, 9, 365);
    const rowHeight = Math.max(18, nameLines.length * 13 + 5);
    if (ensureSpace(context, rowHeight)) drawTableHeader(context);
    nameLines.forEach((nameLine, index) => {
      drawAt(context.page, context.font, nameLine, MARGIN, context.y - index * 13, 9);
    });
    const price = displayMinor(line.amountMinor, invoice.currency);
    drawAt(
      context.page,
      context.font,
      price,
      PAGE_WIDTH - MARGIN - context.font.widthOfTextAtSize(price, 9),
      context.y,
      9,
    );
    context.y -= rowHeight;
  }
}

function drawTotal(
  context: RenderContext,
  label: string,
  amount: string,
  bold = false,
): void {
  ensureSpace(context, 18);
  const font = bold ? context.bold : context.font;
  drawAt(context.page, font, label, 330, context.y, bold ? 11 : 9);
  drawAt(
    context.page,
    font,
    amount,
    PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(amount, bold ? 11 : 9),
    context.y,
    bold ? 11 : 9,
  );
  context.y -= bold ? 22 : 17;
}

function drawTotals(context: RenderContext, invoice: CustomerSafeInvoice): void {
  context.y -= 8;
  ensureSpace(context, 105);
  drawTotal(context, 'Subtotal', displayMinor(invoice.subtotalMinor, invoice.currency));
  drawTotal(context, 'Tax', displayMinor(invoice.taxAmountMinor, invoice.currency));
  drawTotal(context, 'Gross total', displayMinor(invoice.totalMinor, invoice.currency));
  const credit = displayMinor(invoice.creditsAppliedMinor, invoice.currency);
  drawTotal(context, 'Credits applied', invoice.creditsAppliedMinor > 0n ? `−${credit}` : credit);
  drawTotal(
    context,
    'Amount due',
    displayMinor(invoice.totalMinor - invoice.creditsAppliedMinor, invoice.currency),
    true,
  );
}

function drawFooters(document: PDFDocument, font: PDFFont): void {
  const pages = document.getPages();
  pages.forEach((page, index) => {
    drawAt(
      page,
      font,
      'Service prices are final customer prices. Applied credits are shown separately.',
      MARGIN,
      48,
      7,
    );
    const pageLabel = `Page ${index + 1} of ${pages.length}`;
    drawAt(
      page,
      font,
      pageLabel,
      PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(pageLabel, 7),
      48,
      7,
    );
  });
}

export function billingInvoicePdfTemplateVersion(): string {
  return TEMPLATE_VERSION;
}

export async function generateBillingInvoicePdf(invoice: CustomerSafeInvoice): Promise<Uint8Array> {
  if (!invoice.invoiceNumber || !invoice.issueDate || !invoice.dueDate) {
    throw new Error('BILLING_INVOICE_PDF_INPUT_INVALID');
  }
  const issuer = snapshot(invoice.issuerSnapshot, false);
  const buyer = snapshot(invoice.buyerSnapshot, true);
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([readFile(REGULAR_FONT), readFile(BOLD_FONT)]);
  const [font, bold] = await Promise.all([
    document.embedFont(regularBytes, { subset: true }),
    document.embedFont(boldBytes, { subset: true }),
  ]);
  document.setTitle(`Invoice ${invoice.invoiceNumber}`);
  document.setAuthor(issuer.legalName);
  document.setSubject('Customer service invoice');
  document.setCreator(TEMPLATE_VERSION);
  document.setProducer(TEMPLATE_VERSION);
  document.setCreationDate(invoice.issueDate);
  document.setModificationDate(invoice.issueDate);

  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const context: RenderContext = {
    document,
    page,
    font,
    bold,
    invoiceNumber: invoice.invoiceNumber,
    y: 700,
  };
  drawAt(page, bold, 'INVOICE', MARGIN, PAGE_HEIGHT - MARGIN, 22);
  const numberX = PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize(invoice.invoiceNumber, 12);
  drawAt(page, bold, invoice.invoiceNumber, numberX, PAGE_HEIGHT - MARGIN, 12);
  drawAt(page, font, `Issue date: ${invoice.issueDate.toISOString().slice(0, 10)}`, 350, 765, 9);
  drawAt(page, font, `Due date: ${invoice.dueDate.toISOString().slice(0, 10)}`, 350, 750, 9);
  drawAt(page, font, `Billing month: ${invoice.billingMonth}`, 350, 735, 9);

  drawParty(context, 'ISSUED BY', issuer);
  drawParty(context, 'BILL TO', buyer);
  drawServiceLines(context, invoice);
  drawTotals(context, invoice);
  drawFooters(document, font);
  return document.save({ useObjectStreams: false });
}
