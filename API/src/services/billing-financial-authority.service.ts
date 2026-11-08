import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';

/** The selected team admits the actor; an active manager role in this org admits its finances. */
export async function requireBillingManager(subject: {
  userId: string; organisationId: string; teamId: string | null;
}, prisma?: PrismaClient) {
  const viewer = await resolveBillingFundingViewer(subject, { prisma });
  if (!viewer.billingManager) throw new AppError('FORBIDDEN', 403, 'BILLING_MANAGER_REQUIRED');
  return viewer;
}
