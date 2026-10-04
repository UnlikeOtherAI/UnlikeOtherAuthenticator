import { readFile } from 'node:fs/promises';

import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import type { BillingCycleDetailV1 } from '../contracts/billing-statement-v1.js';
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
  const escaped = (/^[=+@\t\r]/.test(value) ||
    (value.startsWith('-') && !/^-\d+(?:\.\d+)?$/.test(value))) ? `'${value}` : value;
  return `"${escaped.replaceAll('"', '""')}"`;
}

function csvRow(values: string[]): string {
  return values.map(csvCell).join(',');
}

export function renderBillingCycleBreakdownCsv(detail: BillingCycleDetailV1): Buffer {
  const rows: string[][] = [[
    'record_type', 'id', 'description', 'period_start', 'period_end', 'quantity',
    'unit', 'customer_charge', 'currency', 'credits_consumed',
  ]];
  for (const line of detail.subscription_lines) {
    rows.push(['subscription', line.id, line.label, detail.period.starts_at,
      detail.period.ends_at, line.quantity ?? '', line.charge_basis,
      line.customer_charge.amount, line.customer_charge.currency, '']);
    for (const interval of line.intervals) {
      rows.push(['seat_interval', line.id, `${line.seat_policy ?? 'flat'} seats`,
        interval.starts_at, interval.ends_at, interval.quantity, 'seats', '', '', '']);
    }
  }
  for (const line of detail.usage_lines) {
    rows.push(['usage', line.id, line.service_id, detail.period.starts_at,
      detail.period.ends_at, line.raw_units.total, line.usage_unit,
      line.customer_charge?.amount ?? '', line.customer_charge?.currency ?? '',
      line.credits_consumed]);
    for (const [kind, quantity] of Object.entries(line.raw_units)) {
      if (kind === 'total') continue;
      rows.push(['measured_dimension', line.id, kind, detail.period.starts_at,
        detail.period.ends_at, quantity, line.usage_unit, '', '', '']);
    }
    for (const modality of line.modalities ?? []) {
      rows.push(['modality', line.id, modality.modality, detail.period.starts_at,
        detail.period.ends_at, modality.raw_units, line.usage_unit, '', '', '']);
    }
  }
  for (const total of detail.totals) {
    rows.push(['total', detail.cycle_id, 'Amount due', detail.period.starts_at,
      detail.period.ends_at, '', '', total.total_due.amount, total.currency,
      detail.credits.consumed]);
  }
  return Buffer.from(`\uFEFF${rows.map(csvRow).join('\r\n')}\r\n`, 'utf8');
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
  context.page.drawText('UOA - Customer billing usage breakdown', {
    x: margin, y: context.y, font: context.bold, size: 10,
    color: rgb(0.16, 0.2, 0.27),
  });
  context.y -= 28;
}

function wrap(value: string, font: PDFFont, size: number): string[] {
  const width = pageWidth - margin * 2;
  const parts = text(value).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line ? `${line} ${part}` : part;
    if (font.widthOfTextAtSize(candidate, size) > width && line) {
      lines.push(line);
      line = part;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function draw(context: DrawContext, value: string, options?: { bold?: boolean; size?: number }): void {
  const font = options?.bold ? context.bold : context.regular;
  const size = options?.size ?? 9;
  for (const line of wrap(value, font, size)) {
    if (context.y < bottom) newPage(context);
    context.page.drawText(line, { x: margin, y: context.y, font, size,
      color: rgb(0.14, 0.17, 0.22) });
    context.y -= size + 6;
  }
}

export async function renderBillingCycleBreakdownPdf(detail: BillingCycleDetailV1): Promise<Buffer> {
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
  draw(context, `${detail.product.name} - ${detail.scope.payer_scope} billing`, { size: 10 });
  draw(context, 'Measured usage and customer charges. This breakdown is not a payment invoice.');
  context.y -= 12;
  draw(context, 'Subscription and seats', { bold: true, size: 12 });
  if (detail.subscription_lines.length === 0) draw(context, 'No confirmed subscription line.');
  for (const line of detail.subscription_lines) {
    draw(context, `${line.label}: ${line.customer_charge.display}`, { bold: true });
    draw(context, `${line.charge_basis}; unit price ${line.unit_price.display}; quantity ${line.quantity ?? 'pending'}`);
    if (line.seat_policy) draw(context,
      `${line.seat_policy} seats, ${line.seat_timing ?? 'timing pending'}; ${line.active_seat_seconds ?? 'pending'} active seat-seconds`);
    for (const interval of line.intervals) {
      draw(context, `${interval.starts_at} to ${interval.ends_at}: ${interval.quantity} seats`);
    }
  }
  context.y -= 8;
  draw(context, 'Measured usage', { bold: true, size: 12 });
  if (detail.usage_lines.length === 0) draw(context, 'No confirmed usage line.');
  for (const line of detail.usage_lines) {
    draw(context, `${line.service_id}: ${line.raw_units.total} ${line.usage_unit}, ${line.calls} calls`,
      { bold: true });
    draw(context, `Input ${line.raw_units.input}; cached input ${line.raw_units.cached_input}; output ${line.raw_units.output}`);
    if (line.raw_units.reasoning) draw(context, `Reasoning ${line.raw_units.reasoning}`);
    if (line.raw_units.cache_write) draw(context, `Cache write ${line.raw_units.cache_write}`);
    for (const modality of line.modalities ?? []) draw(context,
      `${modality.modality}: ${modality.raw_units} ${line.usage_unit}`);
    draw(context, `Customer charge ${line.customer_charge?.display ?? 'pending'}; credits used ${line.credits_consumed}`);
  }
  context.y -= 8;
  draw(context, 'Confirmed totals', { bold: true, size: 12 });
  for (const total of detail.totals) {
    draw(context, `Subscription ${total.subscription.display}; usage ${total.usage_charge.display}; credits ${total.credits_applied.display}`);
    draw(context, `Due ${total.total_due.display}; paid ${total.total_paid.display}; outstanding ${total.outstanding.display}`,
      { bold: true });
  }
  draw(context, `Credits consumed: ${detail.credits.consumed}`);
  if (detail.credits.status === 'pending_reconciliation') {
    draw(context, 'Some usage or credit evidence remains under reconciliation.');
  }
  const pages = document.getPages();
  pages.forEach((page, index) => page.drawText(`Page ${index + 1} of ${pages.length}`, {
    x: margin, y: 30, font: regular, size: 8, color: rgb(0.38, 0.42, 0.47),
  }));
  return Buffer.from(await document.save());
}
