import type { FastifyBaseLogger } from 'fastify';

import { getBillingActorAudienceMode, getPublicBaseUrl } from '../config/env.js';
import { getAppLogger } from '../utils/app-logger.js';
import { AppError } from '../utils/errors.js';

/**
 * Every billing endpoint that authenticates a relying party with an `X-UOA-Actor`
 * assertion. The audience of that assertion must name the exact endpoint it is
 * presented to, so an assertion minted for a read cannot be replayed — inside its
 * 60-second life — against a funding, cancellation, or Stripe endpoint.
 *
 * Paths are declared here rather than imported from each route module so the set of
 * actor-authenticated endpoints is reviewable in one place; every entry is asserted
 * against its route registration in the endpoint-audience tests.
 */
export const BILLING_ACTOR_ENDPOINTS = [
  '/billing/v1/effective-tariff',
  '/billing/v1/service-access/confirm',
  '/billing/v1/customer-statement',
  '/billing/v2/customer-statement',
  '/billing/v1/credits',
  '/billing/v1/credits/top-up-checkout',
  '/billing/v1/credits/auto-top-up/setup',
  '/billing/v1/credits/auto-top-up/update',
  '/billing/v1/credits/auto-top-up/disable',
  '/billing/v1/credits/auto-top-up/recover',
  '/billing/v1/recurring-addons',
  '/billing/v1/recurring-addons/checkout',
  '/billing/v1/recurring-addons/cancellation/preview',
  '/billing/v1/recurring-addons/cancellation/confirm',
  '/billing/v1/cancellation/preview',
  '/billing/v1/cancellation/confirm',
  '/billing/v1/stripe/checkout-session',
  '/billing/v1/stripe/subscription-summary',
  '/billing/v1/stripe/portal-session',
] as const;

export type BillingActorEndpoint = (typeof BILLING_ACTOR_ENDPOINTS)[number];

/**
 * The audience a relying party must mint into `aud` when calling `endpoint`:
 * this deployment's public base URL joined with the exact endpoint path.
 */
export function billingActorAudience(endpoint: BillingActorEndpoint): string {
  return `${getPublicBaseUrl()}${endpoint}`;
}

export type BillingActorAudienceOutcome = 'endpoint' | 'legacy';

/**
 * Decide whether a presented audience is acceptable for `endpoint`.
 *
 * - The exact endpoint audience is always accepted.
 * - The credential's registered legacy audience (one constant for every endpoint,
 *   which is what shipped products currently mint) is accepted only while the
 *   deployment runs in "warn" mode, and is refused in "enforce" mode.
 * - Anything else is refused in both modes.
 *
 * Refusal carries its own code so an integrator can tell an audience mismatch from a
 * bad signature; both remain 401.
 */
export function assertBillingActorAudience(params: {
  presented: string;
  endpoint: BillingActorEndpoint;
  legacyAudience: string;
}): BillingActorAudienceOutcome {
  if (params.presented === billingActorAudience(params.endpoint)) return 'endpoint';
  if (
    params.presented === params.legacyAudience &&
    getBillingActorAudienceMode() === 'warn' &&
    // A legacy audience is only ever a transitional stand-in for a real endpoint
    // audience. It must still be one of this deployment's own billing URLs.
    params.legacyAudience.startsWith(`${getPublicBaseUrl()}/billing/`)
  ) {
    return 'legacy';
  }
  throw new AppError('UNAUTHORIZED', 401, 'BILLING_ACTOR_AUDIENCE_MISMATCH');
}

/**
 * Record that a relying party authenticated with the legacy constant audience, so an
 * operator can see which products still need to move before flipping the deployment to
 * "enforce". Logging must never fail the request that was otherwise accepted, and the
 * app logger is absent in unit tests.
 */
export function logLegacyBillingActorAudience(
  params: {
    endpoint: BillingActorEndpoint;
    presented: string;
    product: string;
    appKeyId: string;
  },
  deps?: { logger?: Pick<FastifyBaseLogger, 'warn'> },
): void {
  try {
    const logger = deps?.logger ?? getAppLogger();
    logger.warn(
      {
        endpoint: params.endpoint,
        presented_audience: params.presented,
        expected_audience: billingActorAudience(params.endpoint),
        product: params.product,
        app_key_id: params.appKeyId,
      },
      'billing actor assertion used the legacy constant audience instead of the endpoint audience',
    );
  } catch {
    // Telemetry is not authoritative; an accepted request stays accepted.
  }
}
