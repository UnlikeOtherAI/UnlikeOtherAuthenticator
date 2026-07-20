import { BillingAppKeyPurpose } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  verifyBillingAppKey,
  type VerifiedBillingAppKey,
} from '../services/billing-app-key.service.js';
import { BILLING_APP_KEY_PREFIX } from '../utils/billing-app-key.js';
import { AppError } from '../utils/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    billingAppKey?: VerifiedBillingAppKey;
  }
}

function assertSingleHeader(value: string | string[]): string {
  if (Array.isArray(value) || value.includes(',')) {
    throw new AppError('UNAUTHORIZED', 401);
  }
  return value;
}

function readCredential(request: FastifyRequest): string {
  const appKeyHeader = request.headers['x-uoa-app-key'];
  if (appKeyHeader !== undefined) {
    if (request.headers.authorization !== undefined) {
      throw new AppError('UNAUTHORIZED', 401);
    }
    const value = assertSingleHeader(appKeyHeader).trim();
    if (!value) throw new AppError('UNAUTHORIZED', 401);
    return value;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' || Array.isArray(authorization)) {
    const value = assertSingleHeader(authorization).trim();
    if (value.toLowerCase().startsWith('bearer ')) {
      const token = value.slice('bearer '.length).trim();
      if (token.startsWith(BILLING_APP_KEY_PREFIX)) return token;
    }
  }
  throw new AppError('UNAUTHORIZED', 401);
}

export async function requireBillingAppKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;
  request.billingAppKey = await verifyBillingAppKey(readCredential(request));
}

async function requireBillingAppKeyPurpose(
  request: FastifyRequest,
  reply: FastifyReply,
  purpose: BillingAppKeyPurpose,
): Promise<void> {
  await requireBillingAppKey(request, reply);
  if (request.billingAppKey?.purpose !== purpose) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_APP_KEY_PURPOSE_MISMATCH');
  }
}

export function requireBillingEntitlementAppKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  return requireBillingAppKeyPurpose(request, reply, BillingAppKeyPurpose.ENTITLEMENT);
}

export function requireBillingLifecycleAppKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  return requireBillingAppKeyPurpose(request, reply, BillingAppKeyPurpose.CUSTOMER_LIFECYCLE);
}
