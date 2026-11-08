import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { StripeAccountContext } from './billing-stripe-client.service.js';

const TTL_MS = 10 * 60_000;
const CONTEXT_PATHS = new Set([
  '/billing/v1/credits/top-up-checkout', '/billing/v1/credits/auto-top-up/setup',
  '/billing/v1/credits/auto-top-up/update', '/billing/v1/credits/auto-top-up/disable',
  '/billing/v1/credits/auto-top-up/recover', '/billing/v1/recurring-addons/checkout',
  '/billing/v1/stripe/checkout-session', '/billing/v1/stripe/portal-session',
  '/billing/v1/cancellation/preview','/billing/v1/recurring-addons/cancellation/preview',
]);
type Binding = { account: StripeAccountContext; revision: number; appKeyId: string; scopeEpoch?: string; objectBinding?:string };

function bodyDigest(body: Record<string, unknown>): string {
  // The one customer-editable field is admitted separately by the purchased-seat guard.
  const entries = Object.entries(body).filter(([key]) =>
    key !== 'billing_context' && key !== 'fixed_seat_quantity').sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(entries)).digest('base64url');
}
function signature(payload: string): string {
  return createHmac('sha256', getEnv().SHARED_SECRET)
    .update(`uoa-displayed-billing-context:v1\0${payload}`).digest('base64url');
}
function bindingValues(binding: Binding, endpoint: string, body: Record<string, unknown>) {
  return [binding.account.id, binding.account.stripeAccountId, binding.account.livemode,
    binding.revision, binding.appKeyId, endpoint, bodyDigest(body)] as const;
}

export function mintBillingActionContext(binding: Binding, endpoint: string,
  body: Record<string, unknown>, now = new Date()): string {
  const payload = Buffer.from(JSON.stringify([binding.objectBinding?3:binding.scopeEpoch ? 2 : 1, now.getTime() + TTL_MS,
    ...bindingValues(binding, endpoint, body), ...(binding.objectBinding?[binding.scopeEpoch??null,binding.objectBinding]:
      binding.scopeEpoch ? [binding.scopeEpoch] : [])])).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function assertBillingActionContext(token: string | undefined, binding: Binding,
  endpoint: string, body: Record<string, unknown>, now = new Date()): void {
  if (token === undefined) {
    if (!binding.scopeEpoch && !binding.objectBinding && binding.revision === 0 && binding.account.livemode) return;
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTEXT_REQUIRED');
  }
  let values: unknown;
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const [payload, mac] = token.split('.') as [string, string];
    const expected = Buffer.from(signature(payload));
    const actual = Buffer.from(mac);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
    values = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch { throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTEXT_INVALID'); }
  if (!Array.isArray(values) || !(values.length === 9 && values[0] === 1 || values.length === 10 && values[0] === 2 ||
    values.length===11&&values[0]===3&&typeof values[10]==='string'&&(values[9]===null||typeof values[9]==='string')) ||
    !Number.isSafeInteger(values[1])) throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTEXT_INVALID');
  const expected = bindingValues(binding, endpoint, body);
  // Subject, app, endpoint and body mismatches are invalid, even if the display also expired.
  if (values[6] !== expected[4] || values[7] !== expected[5] || values[8] !== expected[6]) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTEXT_INVALID');
  }
  if (values[1] <= now.getTime() || values[1] > now.getTime() + TTL_MS ||
    values[2] !== expected[0] || values[3] !== expected[1] ||
    values[4] !== expected[2] || values[5] !== expected[3] ||
    (binding.objectBinding?values[0]!==3||values[9] !== (binding.scopeEpoch??null)||values[10]!==binding.objectBinding:
      binding.scopeEpoch ? values[0] !== 2 || values[9] !== binding.scopeEpoch : values[0] !== 1)) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTEXT_STALE');
  }
}

/** Works on the public DTO only. Never replaces an incoming mutation context. */
export function freezeDisplayedBillingActions<T>(value: T, binding: Binding,
  negotiated: boolean, disabledReason: string, now = new Date()): T {
  const result = structuredClone(value);
  const requireBound = Boolean(binding.scopeEpoch) || Boolean(binding.objectBinding) || binding.revision !== 0 || !binding.account.livemode;
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const object = item as Record<string, unknown>;
    const request = object.request as { method?: unknown; path?: unknown; body?: unknown } | undefined;
    if (request?.method === 'POST' && typeof request.path === 'string' && CONTEXT_PATHS.has(request.path)
      && request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
      if (negotiated) {
        const body = structuredClone(request.body) as Record<string, unknown>;
        request.body=body;
        const captured=['/billing/v1/stripe/portal-session','/billing/v1/cancellation/preview'].includes(request.path);
        body.billing_context = mintBillingActionContext(captured?binding:{...binding,objectBinding:undefined}, request.path, body, now);
      } else if (requireBound) {
        object.enabled = false; object.disabled_reason = disabledReason;
      }
    }
    if (!negotiated && requireBound && object.capabilities && typeof object.capabilities === 'object') {
      const caps = object.capabilities as Record<string, unknown>;
      for (const key of ['can_top_up', 'can_manage_automatic_top_up', 'can_upgrade', 'can_open_portal']) {
        if (key in caps) caps[key] = false;
      }
    }
    Object.values(object).forEach(visit);
    if (!negotiated && requireBound && object.capabilities && typeof object.capabilities === 'object'
      && Array.isArray(object.offers)) {
      const caps = object.capabilities as Record<string, unknown>;
      if ('can_manage_addons' in caps) caps.can_manage_addons = object.offers.some((offer) =>
        Array.isArray(offer.actions) && offer.actions.some((action: { enabled?: boolean }) => action.enabled));
    }
  };
  visit(result);
  return result;
}
