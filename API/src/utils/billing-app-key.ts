import { createHmac, randomBytes } from 'node:crypto';

import { requireEnv } from '../config/env.js';

export const BILLING_APP_KEY_PREFIX = 'uoa_app_';

export function generateBillingAppKey(): string {
  return `${BILLING_APP_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function digestBillingAppKey(
  rawKey: string,
  pepper = requireEnv('SHARED_SECRET').SHARED_SECRET,
): string {
  return createHmac('sha256', pepper).update(rawKey, 'utf8').digest('hex');
}

export function billingAppKeyDisplayPrefix(rawKey: string): string {
  return rawKey.slice(0, 16);
}
