import { AppError } from '../utils/errors.js';

export function normalizeStripeReturnUrl(value: string, allowedOrigins: string[]): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !allowedOrigins.includes(url.origin)
    ) {
      throw new Error('invalid');
    }
    return url.toString();
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_RETURN_URL_NOT_ALLOWED');
  }
}
