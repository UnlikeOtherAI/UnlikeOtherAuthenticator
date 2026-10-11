import { z } from 'zod';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  assertSmsPolicyFresh, insertSmsRoutePolicy, lockSmsPolicyAcceptance, readSmsPolicyPreview,
  signSmsPolicyPreview, SmsPolicyBound, SmsRoutePolicyEvidenceSchema, SmsRoutePolicyImportSchema,
  smsRouteImportDigest, type SmsPolicyActor,
} from './billing-sms-policy-admin.service.js';
import type { BillingSmsProvider } from './billing-sms-provider.service.js';
import {
  SMS_ROUTE_BOUND_RULE, SMS_ROUTE_VALIDITY_MS, smsRoutePricingPage, smsRouteRuleBounds,
  smsRouteRuleEvidence,
} from './billing-sms-route-bound-rule.js';
import { configuredSmsProvider } from './billing-sms-runtime.service.js';

const Country = z.string().regex(/^[A-Z]{2}$/);
const CountryRoute = SmsRoutePolicyEvidenceSchema.extend({ provider_price: SmsPolicyBound }).strict();
const CountryEvidence = z.object({
  country: Country, account_sid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  rule: z.literal(SMS_ROUTE_BOUND_RULE.version), validity_days: z.literal(SMS_ROUTE_BOUND_RULE.validityDays),
  routes: z.tuple([CountryRoute, CountryRoute]),
}).strict().refine(({ country, account_sid: account, routes: [outbound, inbound] }) =>
  outbound.direction === 'outbound' && inbound.direction === 'inbound' &&
  [outbound, inbound].every((route) => route.country === country && route.account_sid === account));
type PricingProvider = Pick<BillingSmsProvider, 'price' | 'configuration'>;

function unsupported(): AppError {
  return new AppError('BAD_REQUEST', 409, 'BILLING_SMS_ROUTE_RULE_UNSUPPORTED');
}

/**
 * Add country: read the configured account's own mobile prices for both
 * directions, apply the versioned bound rule, and assemble and hash the
 * evidence. Nothing is written until the operator accepts the signed review.
 */
export async function previewSmsCountryPolicy(actor: SmsPolicyActor, country: string,
  deps: { provider?: PricingProvider; now?: () => Date } = {}) {
  const code = Country.parse(country);
  const provider = deps.provider ?? configuredSmsProvider();
  const accountSid = provider.configuration.accountSid;
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + SMS_ROUTE_VALIDITY_MS).toISOString();
  const routes: Array<z.infer<typeof CountryRoute>> = [];
  const documents: string[] = [];
  for (const direction of ['outbound', 'inbound'] as const) {
    const price = await provider.price(code, direction);
    // The rule's fees are documented in USD; any other provider currency needs manual evidence.
    if (price.currency !== SMS_ROUTE_BOUND_RULE.currency || !SmsPolicyBound.safeParse(price.amount).success) {
      throw unsupported();
    }
    const value = SmsRoutePolicyImportSchema.parse({ account_sid: accountSid, country: code, direction,
      currency: SMS_ROUTE_BOUND_RULE.currency, ...smsRouteRuleBounds(direction),
      source: smsRoutePricingPage(code), expires_at: expiresAt,
      evidence: smsRouteRuleEvidence({ accountSid, country: code, direction, price }) });
    const { evidence: document, ...dimensions } = value;
    routes.push({ ...dimensions, evidence_digest: smsRouteImportDigest(value),
      observed_at: price.observedAt.toISOString(), provider_price: price.amount });
    documents.push(document);
  }
  const evidence = CountryEvidence.parse({ country: code, account_sid: accountSid,
    rule: SMS_ROUTE_BOUND_RULE.version, validity_days: SMS_ROUTE_BOUND_RULE.validityDays, routes });
  return { ...await signSmsPolicyPreview('country', evidence, actor, now), evidence_documents: documents };
}

/** One Accept: both directions, the three attestations and a generated reason under the operator's subject. */
export async function acceptSmsCountryPolicy(actor: SmsPolicyActor, token: string) {
  const evidence = CountryEvidence.parse(await readSmsPolicyPreview('country', token, actor, new Date()));
  const acceptor = { kind: 'operator', actor } as const;
  const reason = `Add country ${evidence.country}: accepted the Twilio account prices and rule ` +
    `${evidence.rule} bounds for outbound and inbound, attesting the policy, the complete per-segment ` +
    'bound and the complete per-message bound.';
  return getAdminPrisma().$transaction(async (tx) => {
    await lockSmsPolicyAcceptance(tx, acceptor, evidence.routes[0].evidence_digest);
    const now = new Date();
    // A review that expires while waiting for authority locks cannot commit.
    await readSmsPolicyPreview('country', token, actor, now);
    const accepted = [];
    for (const { provider_price: providerPrice, ...route } of evidence.routes) {
      assertSmsPolicyFresh(route.expires_at, now);
      accepted.push(await insertSmsRoutePolicy(tx, route, acceptor, now, reason, { providerPrice }));
    }
    return accepted;
  });
}
