export const PROVISIONED_BILLING_SERVICE_IDENTIFIERS = [
  'nessie',
  'deepwater',
  'deepsignal',
  'deeptest',
] as const;

export type ProvisionedBillingServiceIdentifier =
  (typeof PROVISIONED_BILLING_SERVICE_IDENTIFIERS)[number];

export const CREDIT_FUNDING_POLICY_SPEC = {
  currency: 'USD',
  version: 1,
  topUpEnabled: true,
  automaticTopUpEnabled: true,
  automaticConsentVersion: 'credits-auto-top-up-v1',
} as const;

const MICROCREDITS_PER_CREDIT = 1_000_000n;

export type CreditTopUpSpec = {
  key: string;
  version: number;
  catalogKey: string;
  catalogVersion: number;
  name: string;
  description: string;
  paymentAmountMinor: bigint;
  credits: bigint;
  creditsReceivedMicrocredits: bigint;
  stripeLookupKey: string;
};

function creditTopUpSpec(usd: 10 | 25 | 50 | 100): CreditTopUpSpec {
  const credits = BigInt(usd * 1_000);
  return {
    key: `credits_usd_${usd}`,
    version: 1,
    catalogKey: `credits_usd_${usd}`,
    catalogVersion: 1,
    name: `$${usd} — ${credits.toLocaleString('en-US')} credits`,
    description: `Adds ${credits.toLocaleString('en-US')} credits to the team's shared balance.`,
    paymentAmountMinor: BigInt(usd * 100),
    credits,
    creditsReceivedMicrocredits: credits * MICROCREDITS_PER_CREDIT,
    stripeLookupKey: `uoa_credits_usd_${usd}_v1`,
  };
}

export const CREDIT_TOP_UP_SPECS = [
  creditTopUpSpec(10),
  creditTopUpSpec(25),
  creditTopUpSpec(50),
  creditTopUpSpec(100),
] as const;

export const CREDIT_AUTO_TOP_UP_SPEC = {
  key: 'default',
  version: 1,
  refillOfferKey: 'credits_usd_25',
  thresholdMicrocredits: 5_000n * MICROCREDITS_PER_CREDIT,
  monthlyChargeCapMinor: 10_000n,
} as const;

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
