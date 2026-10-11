import { multiplySmsAmount } from './billing-sms-money.service.js';
import type { SmsPrivatePrice } from './billing-sms-provider.service.js';

/**
 * The one versioned rule behind Admin › SMS policies › Add country. It derives
 * the additional per-segment and per-message bounds for a Twilio long-code
 * mobile SMS route from what Twilio publishes. Any change to a figure or a
 * citation is a new version: each accepted policy hashes the version and the
 * figures into its evidence, so earlier acceptances stay exactly reproducible.
 *
 * Sources, retrieved 11 October 2026:
 * - Country pricing pages (for example https://www.twilio.com/en-us/sms/pricing/gb)
 *   charge SMS per segment, state that additional carrier fees may apply, and link
 *   their carrier-fee section to the US page. They publish no per-country carrier
 *   fee, so the rule never claims zero.
 * - https://www.twilio.com/en-us/sms/pricing/us is the only carrier-fee schedule
 *   Twilio publishes. Highest long-code SMS carrier fee: outbound USD 0.005
 *   (Verizon, US Cellular); inbound USD 0.0035 (AT&T).
 * - https://www.twilio.com/en-us/changelog/twilio-will-bill-for-failed-messages-starting-september-30--2024
 *   documents a USD 0.001 processing fee for messages that end in Failed. Twilio
 *   does not say whether it applies inbound, so the rule applies it both ways.
 * - https://www.twilio.com/docs/glossary/what-sms-character-limit: SMS is billed per segment.
 * - https://www.twilio.com/docs/messaging/api/pricing: `current_price` is the
 *   account's own price, including volume or custom discounts.
 * No source states a validity period and prices may change without notice, so
 * an acceptance lasts 30 days from retrieval.
 */
export const SMS_ROUTE_BOUND_RULE = {
  version: 'TWILIO_LONG_CODE_2X_V1',
  currency: 'USD',
  multiplier: 2,
  validityDays: 30,
  highestCarrierFee: { outbound: '0.005', inbound: '0.0035' },
  failedMessageFee: '0.001',
  carrierFeeSource: 'https://www.twilio.com/en-us/sms/pricing/us',
  failedFeeSource: 'https://www.twilio.com/en-us/changelog/twilio-will-bill-for-failed-messages-starting-september-30--2024',
  segmentSource: 'https://www.twilio.com/docs/glossary/what-sms-character-limit',
  currentPriceSource: 'https://www.twilio.com/docs/messaging/api/pricing',
} as const;

export type SmsRouteDirection = 'inbound' | 'outbound';
export const SMS_ROUTE_VALIDITY_MS = SMS_ROUTE_BOUND_RULE.validityDays * 86_400_000;

export function smsRouteRuleBounds(direction: SmsRouteDirection) {
  const rule = SMS_ROUTE_BOUND_RULE;
  return {
    additional_per_segment: multiplySmsAmount(rule.highestCarrierFee[direction], rule.multiplier).toFixed(),
    additional_per_message: multiplySmsAmount(rule.failedMessageFee, rule.multiplier).toFixed(),
  };
}

export function smsRoutePricingPage(country: string): string {
  return `https://www.twilio.com/en-us/sms/pricing/${country.toLowerCase()}`;
}

/** The evidence document UOA assembles, hashes and shows for one route. */
export function smsRouteRuleEvidence(input: {
  accountSid: string; country: string; direction: SmsRouteDirection; price: SmsPrivatePrice;
}): string {
  const rule = SMS_ROUTE_BOUND_RULE;
  const bounds = smsRouteRuleBounds(input.direction);
  const flow = input.direction === 'outbound' ? 'outbound from' : 'inbound to';
  const retrieved = input.price.observedAt.toISOString();
  return [
    `Twilio route fee evidence, ${input.country}, SMS ${flow} a mobile number, ${rule.currency}. ` +
      `Assembled by UOA at ${retrieved} under rule ${rule.version}.`,
    '',
    `1. Account price: ${input.price.source} returned current_price ${input.price.currency} ` +
      `${input.price.amount} per segment for mobile numbers` +
      `${input.direction === 'outbound' ? ' (the highest across outbound carriers)' : ''} ` +
      `for account ${input.accountSid}, retrieved ${retrieved}. current_price includes volume or ` +
      `custom discounts (${rule.currentPriceSource}).`,
    `2. Public pricing page: ${smsRoutePricingPage(input.country)}. It charges per segment, says ` +
      'additional carrier fees may apply and links its carrier-fee section to the US page; it ' +
      'publishes no carrier fee for this country, so zero is not claimed.',
    `3. Per-segment bound ${rule.currency} ${bounds.additional_per_segment} = ${rule.multiplier} x ` +
      `${rule.currency} ${rule.highestCarrierFee[input.direction]}, the highest ${input.direction} ` +
      `long-code SMS carrier fee Twilio publishes (${rule.carrierFeeSource}).`,
    `4. Per-message bound ${rule.currency} ${bounds.additional_per_message} = ${rule.multiplier} x ` +
      `${rule.currency} ${rule.failedMessageFee}, Twilio's documented failed-message processing fee ` +
      `(${rule.failedFeeSource})${input.direction === 'inbound'
        ? ', applied conservatively because Twilio does not exclude inbound messages' : ''}.`,
    `5. Billing unit: Twilio bills SMS per message segment (${rule.segmentSource}).`,
    `6. Validity: ${rule.validityDays} days after retrieval; no Twilio source states a longer ` +
      'validity and prices may change without notice.',
  ].join('\n');
}
