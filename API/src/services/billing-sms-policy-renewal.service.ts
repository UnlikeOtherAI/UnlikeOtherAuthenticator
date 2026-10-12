import { createHash } from 'node:crypto';
import { Prisma, type BillingSmsRoutePolicy, type PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import {
  readSmsFxEvidence, smsFxWithinBand, SMS_FX_POLICY, SMS_FX_SOURCE, type SmsFxEvidence,
} from './billing-sms-fx-evidence.service.js';
import { compareSmsAmounts } from './billing-sms-money.service.js';
import {
  insertSmsFxPolicy, insertSmsRoutePolicy, lockSmsPolicyAcceptance, SmsPolicyBound,
  SmsRoutePolicyEvidenceSchema, smsFxPolicyValue, type SmsPolicyAcceptor,
} from './billing-sms-policy-admin.service.js';
import {
  raiseSmsPolicyAlert, resolveSmsPolicyAlerts, SMS_FX_ALERT_SUBJECT, smsRouteAlertSubject,
  type SmsPolicyAlertCondition,
} from './billing-sms-policy-alert.service.js';
import type { BillingSmsProvider } from './billing-sms-provider.service.js';
import { SMS_ROUTE_BOUND_RULE, SMS_ROUTE_VALIDITY_MS } from './billing-sms-route-bound-rule.js';
import { configuredSmsProvider } from './billing-sms-runtime.service.js';

const JOB: SmsPolicyAcceptor = { kind: 'renewal_job' };
type PricingProvider = Pick<BillingSmsProvider, 'price' | 'configuration'>;
export type SmsPolicyRenewalDeps = {
  prisma?: PrismaClient;
  now?: () => Date;
  readFx?: () => Promise<SmsFxEvidence>;
  provider?: () => PricingProvider;
  /** Called once per newly opened alert. */
  notify: (condition: SmsPolicyAlertCondition) => Promise<void>;
};
export type SmsPolicyRenewalResult = {
  fx: 'accepted' | 'current' | 'alerted';
  routes: { checked: number; renewed: number; alerted: number } | 'provider_unavailable';
};

/** The price rule: re-attest only at or below the price an operator attested with the bounds. */
export function smsRouteRenewalDecision(attestedPrice: string | null, currentPrice: string):
  'renew' | 'needs_operator' | 'price_rose' {
  if (attestedPrice === null) return 'needs_operator';
  return compareSmsAmounts(currentPrice, attestedPrice) <= 0 ? 'renew' : 'price_rose';
}

function utc(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

async function alert(db: PrismaClient, deps: SmsPolicyRenewalDeps, condition: SmsPolicyAlertCondition,
  now: Date): Promise<void> {
  if (await raiseSmsPolicyAlert(db, condition, now)) await deps.notify(condition);
  await resolveSmsPolicyAlerts(db, condition.subject, now, condition.kind);
}

async function renewFx(db: PrismaClient, deps: SmsPolicyRenewalDeps, now: Date, bandBps: number) {
  const subject = SMS_FX_ALERT_SUBJECT;
  const last = await db.billingSmsFxSnapshot.findFirst({ where: { policy: SMS_FX_POLICY },
    orderBy: [{ rateDate: 'desc' }, { acceptedAt: 'desc' }] });
  const lastExpiry = last ? ` The accepted rate expires ${utc(last.expiresAt)}.` : '';
  let evidence: SmsFxEvidence;
  try {
    evidence = await (deps.readFx ?? readSmsFxEvidence)();
  } catch {
    await alert(db, deps, { kind: 'fx_unavailable', subject, message: 'The official ECB daily reference ' +
      `(${SMS_FX_SOURCE}) could not be fetched or validated, so no new rate was accepted.${lastExpiry}` }, now);
    return 'alerted' as const;
  }
  const label = `ECB ${evidence.rateDate.toISOString().slice(0, 10)} USD/EUR ${evidence.usdPerEur}`;
  // Refreshing the same or an older source never adds a record or extends its date-bound validity,
  // except to record the GBP rate an earlier acceptance of the same document did not.
  const addsGbp = last?.sourceDigest === evidence.sourceDigest && last.gbpPerEur === null && evidence.gbpPerEur !== null;
  if (last && !addsGbp && (last.sourceDigest === evidence.sourceDigest || last.rateDate >= evidence.rateDate)) {
    await resolveSmsPolicyAlerts(db, subject, now);
    return 'current' as const;
  }
  if (!last) {
    await alert(db, deps, { kind: 'fx_no_baseline', subject, message: `No ECB reference rate has been ` +
      `accepted yet, so ${label} has nothing to be compared with. Accept the first rate in person.` }, now);
    return 'alerted' as const;
  }
  const lastRate = last.usdPerEur.toFixed();
  const band = `±${(bandBps / 100).toFixed(2)}%`;
  if (!smsFxWithinBand(lastRate, evidence.usdPerEur, bandBps)) {
    await alert(db, deps, { kind: 'fx_outside_band', subject, message: `${label} differs from the last ` +
      `accepted ${lastRate} by more than ${band}, so it was not accepted automatically. Review it under ` +
      `Dated ECB reference rate.${lastExpiry}` }, now);
    return 'alerted' as const;
  }
  const value = smsFxPolicyValue(evidence);
  await db.$transaction(async (tx) => {
    await lockSmsPolicyAcceptance(tx, JOB, value.source_digest);
    await insertSmsFxPolicy(tx, value, JOB, now, `Automatic renewal: official ECB daily reference ` +
      `${value.rate_date}, USD/EUR ${value.usd_per_eur}, within ${band} of the last accepted ${lastRate}; ` +
      'adopted under the operator-accepted ECB reference conversion policy.');
  });
  await resolveSmsPolicyAlerts(db, subject, now);
  return 'accepted' as const;
}

async function renewRoute(db: PrismaClient, deps: SmsPolicyRenewalDeps, provider: PricingProvider,
  policy: BillingSmsRoutePolicy, horizon: Date, now: Date): Promise<'renewed' | 'alerted'> {
  const subject = smsRouteAlertSubject(policy);
  const label = `${policy.country} ${policy.direction} ${policy.currency} route fee bounds expire ${utc(policy.expiresAt)}.`;
  const raise = async (kind: SmsPolicyAlertCondition['kind'], message: string) => {
    await alert(db, deps, { kind, subject, message: `${label} ${message}` }, now);
    return 'alerted' as const;
  };
  const root = policy.acceptedBy === 'operator' ? policy : policy.renewalOfId
    ? await db.billingSmsRoutePolicy.findUnique({ where: { id: policy.renewalOfId } }) : null;
  const attested = root?.acceptedBy === 'operator' ? root.providerPrice?.toFixed() ?? null : null;
  if (!root || attested === null) {
    return raise('route_needs_operator', 'They were accepted without a recorded Twilio account price ' +
      '(manual evidence, or accepted before automatic renewal), so they cannot renew automatically. ' +
      'Accept the country again with Add country, or enter evidence manually.');
  }
  let price: Awaited<ReturnType<PricingProvider['price']>>;
  try {
    price = await provider.price(policy.country, policy.direction as 'inbound' | 'outbound');
  } catch {
    return raise('route_price_unavailable', 'The Twilio Pricing API could not be read, so they were not ' +
      'renewed. The job retries daily.');
  }
  if (price.currency !== policy.currency || !SmsPolicyBound.safeParse(price.amount).success) {
    return raise('route_price_unavailable', `The Twilio Pricing API returned ${price.currency} ` +
      `${price.amount.slice(0, 40)}, which cannot be compared with the attested ${policy.currency} ` +
      `${attested}, so they were not renewed.`);
  }
  if (smsRouteRenewalDecision(attested, price.amount) === 'price_rose') {
    return raise('route_price_rose', `The Twilio account price rose from ${policy.currency} ${attested} to ` +
      `${price.amount} since an operator accepted these bounds, so they were not re-attested. Review the ` +
      'route and accept it again with Add country.');
  }
  const expiresAt = new Date(now.getTime() + SMS_ROUTE_VALIDITY_MS);
  const terms = { account_sid: root.accountSid, country: root.country, direction: root.direction,
    currency: root.currency, additional_per_segment: root.additionalPerSegment.toFixed(),
    additional_per_message: root.additionalPerMessage.toFixed(), source: root.source,
    expires_at: expiresAt.toISOString() };
  // The renewal's own document: the operator acceptance it re-attests plus the fresh price reading.
  const document = { kind: 'sms_route_policy_renewal_v1', renewal_of: root.id,
    renewal_of_evidence_digest: root.evidenceDigest, renews: policy.id, ...terms,
    attested_provider_price: attested, observed_provider_price: price.amount, pricing_source: price.source,
    observed_at: price.observedAt.toISOString() };
  const value = SmsRoutePolicyEvidenceSchema.parse({ ...terms, observed_at: now.toISOString(),
    evidence_digest: createHash('sha256').update(JSON.stringify(document)).digest('hex') });
  await db.$transaction(async (tx) => {
    // Instances renew one route at a time; a peer or an operator may already have extended it.
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`uoa:sms-route-renewal:${subject}`}, 0))::text`);
    const covered = await tx.billingSmsRoutePolicy.findFirst({ where: { accountSid: policy.accountSid,
      country: policy.country, direction: policy.direction, currency: policy.currency,
      expiresAt: { gt: horizon } } });
    if (covered) return;
    await lockSmsPolicyAcceptance(tx, JOB, value.evidence_digest);
    await insertSmsRoutePolicy(tx, value, JOB, now, `Automatic renewal: Twilio account price ` +
      `${policy.currency} ${price.amount} is not above the ${attested} an operator attested with these ` +
      `bounds; the operator's bounds, source and evidence are re-attested for ` +
      `${SMS_ROUTE_BOUND_RULE.validityDays} days.`, { providerPrice: price.amount, renewalOfId: root.id });
  });
  await resolveSmsPolicyAlerts(db, subject, now);
  return 'renewed';
}

async function renewRoutes(db: PrismaClient, deps: SmsPolicyRenewalDeps, now: Date, lookaheadDays: number) {
  let provider: PricingProvider;
  try {
    provider = (deps.provider ?? configuredSmsProvider)();
  } catch {
    return 'provider_unavailable' as const;
  }
  const horizon = new Date(now.getTime() + lookaheadDays * 86_400_000);
  const current = await db.billingSmsRoutePolicy.findMany({
    where: { accountSid: provider.configuration.accountSid, expiresAt: { gt: now } },
    orderBy: [{ expiresAt: 'desc' }, { acceptedAt: 'desc' }], take: 500,
  });
  // The route's coverage is its latest-expiring fresh policy; older overlapping rows need nothing.
  const latest = new Map<string, BillingSmsRoutePolicy>();
  for (const row of current) if (!latest.has(smsRouteAlertSubject(row))) latest.set(smsRouteAlertSubject(row), row);
  const result = { checked: 0, renewed: 0, alerted: 0 };
  for (const [subject, policy] of latest) {
    if (policy.expiresAt > horizon) {
      await resolveSmsPolicyAlerts(db, subject, now);
      continue;
    }
    result.checked += 1;
    const outcome = await renewRoute(db, deps, provider, policy, horizon, now);
    result[outcome === 'renewed' ? 'renewed' : 'alerted'] += 1;
  }
  return result;
}

/** One daily pass: accept the newest in-band ECB rate, then re-attest routes nearing expiry. */
export async function runSmsPolicyRenewalCycle(deps: SmsPolicyRenewalDeps): Promise<SmsPolicyRenewalResult> {
  const db = deps.prisma ?? getAdminPrisma();
  const env = getEnv();
  const now = deps.now?.() ?? new Date();
  const fx = await renewFx(db, deps, now, env.BILLING_SMS_POLICY_AUTORENEW_FX_BAND_BPS);
  const routes = await renewRoutes(db, deps, now, env.BILLING_SMS_POLICY_AUTORENEW_LOOKAHEAD_DAYS);
  return { fx, routes };
}
