import { AppError } from '../utils/errors.js';

function pdfUrl(value: string | null | undefined): URL {
  if (!value) throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_PDF_PENDING');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'pay.stripe.com' ||
      !url.pathname.startsWith('/invoice/')) {
    throw new AppError('INTERNAL', 502, 'STRIPE_PAYMENT_INVOICE_PDF_URL_INVALID');
  }
  return url;
}

export async function downloadStripeInvoicePdf(value: string | null | undefined,
  download: typeof fetch = fetch): Promise<Uint8Array> {
  const url = pdfUrl(value);
  const response = await download(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new AppError('INTERNAL', 503, 'STRIPE_PAYMENT_INVOICE_PDF_UNAVAILABLE');
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > 5_000_000) {
    throw new AppError('INTERNAL', 502, 'STRIPE_PAYMENT_INVOICE_PDF_TOO_LARGE');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 5_000_000 || bytes.length < 8 ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new AppError('INTERNAL', 502, 'STRIPE_PAYMENT_INVOICE_PDF_INVALID');
  }
  return bytes;
}
