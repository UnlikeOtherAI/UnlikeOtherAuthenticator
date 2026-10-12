/** The services that sell shared credits through the catalog. DeepSignal does not. */
export const PROVISIONED_BILLING_SERVICE_IDENTIFIERS = [
  'nessie',
  'deepwater',
  'deeptest',
  'docgen',
  'salesnerd',
] as const;

/**
 * The USD rows the first catalog version provisioned for every service. An
 * uncovered service keeps these until someone decides; everything else the
 * catalog gave it is retired.
 */
export const ORIGINAL_USD_CREDIT_OFFER_KEYS = ['credits_usd_10', 'credits_usd_25', 'credits_usd_50', 'credits_usd_100'];

export type ProvisionedBillingServiceIdentifier =
  (typeof PROVISIONED_BILLING_SERVICE_IDENTIFIERS)[number];

/** Credits are the one USD-denominated unit; a region buys them in its own currency. */
export const CREDIT_PURCHASE_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type CreditPurchaseCurrency = (typeof CREDIT_PURCHASE_CURRENCIES)[number];

/** One active funding policy per service and purchase currency. */
export function creditFundingPolicySpec(currency: CreditPurchaseCurrency) {
  return {
    currency,
    version: 1,
    topUpEnabled: true,
    automaticTopUpEnabled: true,
    automaticConsentVersion: 'credits-auto-top-up-v1',
  } as const;
}
export const CREDIT_FUNDING_POLICY_SPEC = creditFundingPolicySpec('USD');

const MICROCREDITS_PER_CREDIT = 1_000_000n;
const TOP_UP_AMOUNTS = [10, 25, 50, 100, 1000] as const;

export type CreditTopUpSpec = {
  key: string;
  version: number;
  catalogKey: string;
  catalogVersion: number;
  currency: CreditPurchaseCurrency;
  name: string;
  description: string;
  paymentAmountMinor: bigint;
  /** Fixed for USD (1,000 per dollar); null when credits follow the live rate at checkout. */
  credits: bigint | null;
  creditsReceivedMicrocredits: bigint;
  stripeLookupKey: string;
};

function creditTopUpSpec(currency: CreditPurchaseCurrency, amount: (typeof TOP_UP_AMOUNTS)[number]): CreditTopUpSpec {
  const code = currency.toLowerCase();
  const base = { key: `credits_${code}_${amount}`, version: 1, catalogKey: `credits_${code}_${amount}`,
    catalogVersion: 1, currency, paymentAmountMinor: BigInt(amount * 100),
    stripeLookupKey: `uoa_credits_${code}_${amount}_v1` };
  if (currency !== 'USD') {
    return { ...base, credits: null, creditsReceivedMicrocredits: 0n,
      name: `${currency} ${amount} — credits at the live rate`,
      description: `Adds credits to the team's shared balance at Stripe's live ${currency} to USD rate, ` +
        'shown before you pay.' };
  }
  const credits = BigInt(amount * 1_000);
  return { ...base, credits, creditsReceivedMicrocredits: credits * MICROCREDITS_PER_CREDIT,
    name: `$${amount} — ${credits.toLocaleString('en-US')} credits`,
    description: `Adds ${credits.toLocaleString('en-US')} credits to the team's shared balance.` };
}

export const CREDIT_TOP_UP_SPECS = CREDIT_PURCHASE_CURRENCIES.flatMap((currency) =>
  TOP_UP_AMOUNTS.map((amount) => creditTopUpSpec(currency, amount)));

export const CREDIT_AUTO_TOP_UP_SPEC = {
  key: 'default',
  version: 1,
  refillOfferKey: 'credits_usd_25',
  thresholdMicrocredits: 5_000n * MICROCREDITS_PER_CREDIT,
  monthlyChargeCapMinor: 10_000n,
} as const;

export type CreditAutoTopUpOptionSpec = {
  key: string;
  version: number;
  currency: CreditPurchaseCurrency;
  refillOfferKey: string;
  /** A USD option's threshold in credits; 0 for GBP and EUR. */
  thresholdMicrocredits: bigint;
  /** A GBP or EUR option's threshold in its currency; null for USD. */
  thresholdAmountMinor: bigint | null;
  monthlyChargeCapMinor: bigint;
};

/**
 * One automatic reload option per currency and refill amount. Each reloads one
 * offer when the balance falls below a fifth of it, up to four reloads a month:
 * the terms of the original USD 25 option (below 5,000 credits, USD 100 cap),
 * which keeps its key.
 */
export const CREDIT_AUTO_TOP_UP_OPTION_SPECS: CreditAutoTopUpOptionSpec[] =
  CREDIT_PURCHASE_CURRENCIES.flatMap((currency) => TOP_UP_AMOUNTS.map((amount) => {
    const code = currency.toLowerCase();
    const minor = BigInt(amount * 100);
    const usd = currency === 'USD';
    return {
      key: usd && amount === 25 ? CREDIT_AUTO_TOP_UP_SPEC.key : `refill_${code}_${amount}`,
      version: 1,
      currency,
      refillOfferKey: `credits_${code}_${amount}`,
      thresholdMicrocredits: usd ? (minor / 5n) * 10_000_000n : 0n,
      thresholdAmountMinor: usd ? null : minor / 5n,
      monthlyChargeCapMinor: minor * 4n,
    };
  }));

export const DEEPWATER_PRIVACY_SPEC = {
  serviceIdentifier: 'deepwater',
  key: 'privacy',
  version: 1,
  name: 'Privacy',
  description: 'Monthly DeepWater privacy add-on for an exact UOA team.',
  benefits: ['Private DeepWater research for this team.'],
  monthlyAmountMinor: 5_000n,
  currency: 'USD',
  stripeLookupKey: 'deepwater_privacy_usd_month_v1',
  appIdentifier: 'deepwater-api',
  featureFlagKey: 'can_be_private',
  featureFlagDescription: 'Allows paid private DeepWater research for an entitled team.',
} as const;

export const CREDIT_PRODUCT_METADATA = {
  contract_version: '1',
  credits_per_usd: '1000',
  uoa_kind: 'team_credits',
} as const;

export function creditPriceMetadata(
  spec: Pick<CreditTopUpSpec, 'credits'>,
): Record<string, string> {
  // A live-rate Price names its basis instead of a credit count it cannot know.
  if (spec.credits === null) return { credits_basis: 'live_fx_rate', uoa_kind: 'team_credit_top_up' };
  return {
    credits: spec.credits.toString(),
    uoa_kind: 'team_credit_top_up',
  };
}

function stripeAddonServiceIdentifier(serviceIdentifier: string): string {
  return serviceIdentifier === 'deepwater' ? 'deep-water' : serviceIdentifier;
}

export function recurringAddonProductMetadata(params: {
  serviceIdentifier: string;
  offerKey: string;
  offerVersion: number;
}): Record<string, string> {
  return {
    contract_version: params.offerVersion.toString(),
    uoa_addon_key: params.offerKey,
    uoa_kind: 'recurring_addon',
    uoa_service: stripeAddonServiceIdentifier(params.serviceIdentifier),
  };
}

export function recurringAddonPriceMetadata(params: {
  serviceIdentifier: string;
  offerKey: string;
}): Record<string, string> {
  return {
    uoa_addon_key: params.offerKey,
    uoa_kind: 'recurring_addon',
    uoa_service: stripeAddonServiceIdentifier(params.serviceIdentifier),
  };
}
