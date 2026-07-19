import { z } from 'zod';

import { AppError } from '../../utils/errors.js';

export const BillingSubjectRequestSchema = z
  .object({
    product: z.string().trim().min(1).max(100),
    organisation_id: z.string().trim().min(1).max(256),
    team_id: z.string().trim().min(1).max(256),
    user_id: z.string().trim().min(1).max(256),
  })
  .strict();

export function readBillingActorHeader(value: string | string[] | undefined): string {
  if (value === undefined || Array.isArray(value) || value.includes(',') || !value.trim()) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_BILLING_ACTOR');
  }
  return value.trim();
}
