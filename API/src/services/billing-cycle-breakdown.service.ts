import { readFile } from 'node:fs/promises';

import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import type { BillingCycleDetailV2 } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';

const regularFont = new URL('../../../assets/fonts/DejaVuSans.ttf', import.meta.url);
const boldFont = new URL('../../../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url);
const pageWidth = 595;
const pageHeight = 842;
const margin = 42;
const bottom = 55;

function text(value: string): string {
  return Array.from(value.normalize('NFC'), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('').trim();
}

function csvCell(value: string): string {
  let first = 0;
  while (first < value.length && (value.charCodeAt(first) <= 32 ||
    /\s/u.test(value[first] ?? ''))) first += 1;
  const escaped = '=+@-'.includes(value[first] ?? '') && first < value.length
    ? `'${value}` : value;
  return `"${escaped.replaceAll('"', '""')}"`;
}

function csvRow(values: readonly string[]): string {
  return values.map(csvCell).join(',');
}

export function renderBillingCycleBreakdownCsv(detail: BillingCycleDetailV2): Buffer {
  const columns = [
    'record_type', 'id', 'description', 'period_start', 'period_end', 'quantity',
    'unit', 'unit_price', 'seat_policy', 'seat_timing', 'usage_payment_mode', 'customer_charge',
    'currency', 'credits_consumed', 'credits_waived', 'tax', 'gross_total', 'credits_applied',
    'total_paid', 'outstanding',
    'opening_balance', 'closing_balance', 'billing_status',
  ] as const;
  type Column = typeof columns[number];
  const rows: Array<Partial<Record<Column, string>>> = [];
  const period = { period_start: detail.period.starts_at,
    period_end: detail.period.ends_at };
  for (const line of detail.subscription_lines) {
    rows.push({ record_type: 'subscription', id: line.id, description: line.label,
      ...period, quantity: line.quantity ?? 'pending', unit: line.charge_basis,
      unit_price: line.unit_price.amount, seat_policy: line.seat_policy ?? '',
      seat_timing: line.seat_timing ?? '', customer_charge: line.customer_charge.amount,
      currency: line.customer_charge.currency, billing_status: detail.state });
    for (const interval of line.intervals) {
      rows.push({ record_type: 'seat_interval', id: line.id,
        description: `${line.seat_policy ?? 'flat'} seats`,
        period_start: interval.starts_at, period_end: interval.ends_at,
        quantity: interval.quantity, unit: 'seats',
        unit_price: line.unit_price.amount, seat_policy: line.seat_policy ?? '',
        seat_timing: line.seat_timing ?? '', billing_status: detail.state });
    }
  }
  for (const line of detail.usage_lines) {
    rows.push({ record_type: 'usage', id: line.id, description: line.label,
      ...period, usage_payment_mode: line.usage_payment_mode,
      customer_charge: line.customer_charge?.amount ??
        (line.usage_payment_mode === 'prepaid' ? 'covered by prepaid credits' : 'pending'),
      currency: line.customer_charge?.currency ?? '',
      credits_consumed: line.credits_consumed ?? 'pending',
      billing_status: detail.state });
  }
  for (const total of detail.totals) {
    rows.push({ record_type: 'total', id: detail.cycle_id,
      description: 'Amount due', ...period, customer_charge: total.total_due.amount,
      currency: total.currency, credits_consumed: detail.credits.consumed ?? 'pending',
      credits_waived: detail.credits.waived ?? 'pending',
      tax: total.tax.amount, gross_total: total.gross_total.amount,
      credits_applied: total.credits_applied.amount,
      total_paid: total.total_paid.amount, outstanding: total.outstanding.amount,
      opening_balance: detail.credits.opening_balance ?? 'pending',
      closing_balance: detail.credits.closing_balance ?? 'pending',
      billing_status: detail.state });
  }
  rows.push({ record_type: 'status', id: detail.cycle_id,
    description: detail.state === 'pending_reconciliation'
      ? 'Pending reconciliation' : detail.state,
    ...period, credits_consumed: detail.credits.consumed ?? 'pending',
    credits_waived: detail.credits.waived ?? 'pending',
    opening_balance: detail.credits.opening_balance ?? 'pending',
    closing_balance: detail.credits.closing_balance ?? 'pending',
    billing_status: detail.state });
  return Buffer.from(`\uFEFF${[columns, ...rows.map((row) =>
    columns.map((column) => row[column] ?? ''))].map(csvRow).join('\r\n')}\r\n`, 'utf8');
}

type DrawContext = {
  document: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
  pageNumber: number;
};

function newPage(context: DrawContext): void {
  if (context.pageNumber > 0) context.page = context.document.addPage([pageWidth, pageHeight]);
  context.pageNumber += 1;
  context.y = pageHeight - margin;
  context.page.drawText('UOA - Customer billing charge breakdown', {
    x: margin, y: context.y, font: context.bold, size: 10,
    color: rgb(0.16, 0.2, 0.27),
  });
  context.y -= 28;
}

export function wrapCycleBreakdownText(value: string, font: PDFFont, size: number): string[] {
  const width = pageWidth - margin * 2;
  const parts = text(value).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    let remainder = part;
    while (remainder) {
      const separator = line ? ' ' : '';
      const candidate = `${line}${separator}${remainder}`;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        break;
      }
      if (line) {
        lines.push(line);
        line = '';
        continue;
      }
      let chunk = '';
      for (const character of remainder) {
        if (font.widthOfTextAtSize(chunk + character, size) > width) break;
        chunk += character;
      }
      if (!chunk) throw new AppError('INTERNAL', 500, 'BILLING_CYCLE_PDF_GLYPH_TOO_WIDE');
      lines.push(chunk);
      remainder = remainder.slice(chunk.length);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function draw(context: DrawContext, value: string, options?: { bold?: boolean; size?: number }): void {
  const font = options?.bold ? context.bold : context.regular;
  const size = options?.size ?? 9;
  for (const line of wrapCycleBreakdownText(value, font, size)) {
    if (context.y < bottom) newPage(context);
    context.page.drawText(line, { x: margin, y: context.y, font, size,
      color: rgb(0.14, 0.17, 0.22) });
    context.y -= size + 6;
  }
}

export async function renderBillingCycleBreakdownPdf(detail: BillingCycleDetailV2): Promise<Buffer> {
  if (detail.state === 'open_preview') {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CYCLE_PREVIEW_NOT_FINAL');
  }
  const document = await PDFDocument.create();
  document.registerFontkit((await import('@pdf-lib/fontkit')).default);
  const [regular, bold] = await Promise.all([
    readFile(regularFont).then((bytes) => document.embedFont(bytes)),
    readFile(boldFont).then((bytes) => document.embedFont(bytes)),
  ]);
  const context: DrawContext = {
    document, page: document.addPage([pageWidth, pageHeight]), regular, bold,
    y: pageHeight - margin, pageNumber: 0,
  };
  newPage(context);
  draw(context, `Billing month ${detail.period.month}`, { bold: true, size: 17 });
  if (detail.state === 'voided') {
    draw(context, 'Voided invoice — no current amount due.', { bold: true, size: 12 });
  }
  draw(context, `${detail.product.name} - ${detail.scope.payer_scope} billing`, { size: 10 });
  draw(context, 'Customer charges and credits. This breakdown is not a payment invoice.');
  context.y -= 12;
  draw(context, 'Subscription and seats', { bold: true, size: 12 });
  if (detail.subscription_lines.length === 0) draw(context, 'No confirmed subscription line.');
  for (const line of detail.subscription_lines) {
    draw(context, `${line.label}: ${line.customer_charge.display}`, { bold: true });
    draw(context, `${line.charge_basis === 'per_seat' ? 'Per seat' : 'Flat monthly'}; unit price ${line.unit_price.display}; quantity ${line.quantity ?? 'pending'}`);
    if (line.seat_policy) draw(context,
      `${line.seat_policy === 'fixed' ? 'Fixed' : 'Automatic'} seats, ${line.seat_timing === 'full_month' ? 'full month' : 'prorated'}; ${line.active_seat_seconds ?? 'pending'} active seat-seconds`);
    for (const interval of line.intervals) {
      draw(context, `${interval.starts_at} to ${interval.ends_at}: ${interval.quantity} seats`);
    }
  }
  context.y -= 8;
  draw(context, 'Usage charges', { bold: true, size: 12 });
  if (detail.usage_lines.length === 0) draw(context, 'No confirmed usage line.');
  for (const line of detail.usage_lines) {
    draw(context, line.label, { bold: true });
    draw(context, `${line.usage_payment_mode === 'prepaid' ?
      'Covered by prepaid credits' : `Customer charge ${line.customer_charge?.display ?? 'pending'}`}; credits used ${line.credits_consumed ?? 'pending'}`);
  }
  context.y -= 8;
  draw(context, detail.state === 'pending_reconciliation'
    ? 'Pending totals' : detail.state === 'voided' ? 'Voided totals' : 'Confirmed totals',
  { bold: true, size: 12 });
  for (const total of detail.totals) {
    draw(context, `Subscription ${total.subscription.display}; usage ${total.usage_charge.display}; tax ${total.tax.display}`);
    draw(context, `Gross ${total.gross_total.display}; credits ${total.credits_applied.display}`);
    draw(context, `Due ${total.total_due.display}; paid ${total.total_paid.display}; outstanding ${total.outstanding.display}`,
      { bold: true });
  }
  draw(context, `Credits consumed: ${detail.credits.consumed ?? 'pending'}`);
  if (detail.credits.waived && detail.credits.waived !== '0') {
    draw(context, `Credits waived: ${detail.credits.waived}`);
  }
  draw(context, `Opening credit balance: ${detail.credits.opening_balance ?? 'pending'}; closing credit balance: ${detail.credits.closing_balance ?? 'pending'}`);
  if (detail.credits.status === 'pending_reconciliation') {
    draw(context, 'Some usage or credit evidence remains under reconciliation.');
  }
  const pages = document.getPages();
  pages.forEach((page, index) => page.drawText(`Page ${index + 1} of ${pages.length}`, {
    x: margin, y: 30, font: regular, size: 8, color: rgb(0.38, 0.42, 0.47),
  }));
  return Buffer.from(await document.save());
}
