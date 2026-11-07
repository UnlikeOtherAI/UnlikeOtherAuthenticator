import { z } from 'zod';
import { BILLING_MODE_PROTOCOL_HEADER, BILLING_MODE_PROTOCOL_VERSION }
  from '../../contracts/billing-statement-v1.js';
import { AppError } from '../../utils/errors.js';

export const BillingContextSchema = z.string().min(1).max(2048).optional();
export function readBillingModeProtocol(headers: Record<string, string | string[] | undefined>): boolean {
  const value = headers[BILLING_MODE_PROTOCOL_HEADER];
  if (value === undefined) return false;
  if (value !== BILLING_MODE_PROTOCOL_VERSION) throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTEXT_INVALID');
  return true;
}
