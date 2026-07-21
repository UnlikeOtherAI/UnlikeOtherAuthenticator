export const unsignedDecimalPattern = '^(0|[1-9][0-9]*)(\\.[0-9]+)?$';
export const positiveDecimalPattern =
  '^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$';
export const signedDecimalPattern = '^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$';
export const unsignedMinorPattern = '^(0|[1-9][0-9]*)$';
export const positiveMinorPattern = '^[1-9][0-9]*$';
export const signedMinorPattern = '^-?(0|[1-9][0-9]*)$';
const unsignedCreditPattern = '^(0|[1-9][0-9]*)(\\.[0-9]{1,5})?$';
const signedCreditPattern = '^-?(0|[1-9][0-9]*)(\\.[0-9]{1,5})?$';
const positiveCreditPattern =
  '^(?:[1-9][0-9]*(?:\\.[0-9]{1,5})?|0\\.(?=[0-9]{1,5}$)[0-9]*[1-9][0-9]*)$';
const unsignedUsdEquivalentPattern = '^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$';
const signedUsdEquivalentPattern = '^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$';
const positiveUsdEquivalentPattern =
  '^(?:[1-9][0-9]*(?:\\.[0-9]{1,8})?|0\\.(?=[0-9]{1,8}$)[0-9]*[1-9][0-9]*)$';

export function moneySchema(
  options: { signed?: boolean; positive?: boolean; usdOnly?: boolean } = {},
) {
  const amountPattern = options.signed
    ? signedDecimalPattern
    : options.positive
      ? positiveDecimalPattern
      : unsignedDecimalPattern;
  const minorPattern = options.signed
    ? signedMinorPattern
    : options.positive
      ? positiveMinorPattern
      : unsignedMinorPattern;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['amount', 'amount_minor', 'currency', 'display'],
    properties: {
      amount: { type: 'string', pattern: amountPattern },
      amount_minor: { type: 'string', pattern: minorPattern },
      currency: options.usdOnly ? { const: 'USD' } : { type: 'string', pattern: '^[A-Z]{3}$' },
      display: { type: 'string' },
    },
  } as const;
}

export function creditAmountSchema(options: { signed?: boolean; positive?: boolean } = {}) {
  const creditsPattern = options.signed
    ? signedCreditPattern
    : options.positive
      ? positiveCreditPattern
      : unsignedCreditPattern;
  const usdAmountPattern = options.signed
    ? signedUsdEquivalentPattern
    : options.positive
      ? positiveUsdEquivalentPattern
      : unsignedUsdEquivalentPattern;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['credits', 'display', 'usd_equivalent'],
    properties: {
      credits: { type: 'string', pattern: creditsPattern },
      display: { type: 'string' },
      usd_equivalent: {
        type: 'object',
        additionalProperties: false,
        required: ['amount', 'currency', 'display'],
        properties: {
          amount: { type: 'string', pattern: usdAmountPattern },
          currency: { const: 'USD' },
          display: { type: 'string' },
        },
      },
    },
  } as const;
}

export const nullableDateTimeSchema = {
  anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
} as const;

export type BillingSubjectRequest = {
  product: string;
  organisation_id: string;
  team_id: string;
  user_id: string;
};

export const billingSubjectRequestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'organisation_id', 'team_id', 'user_id'],
  properties: {
    product: { type: 'string', minLength: 1, maxLength: 100 },
    organisation_id: { type: 'string', minLength: 1, maxLength: 256 },
    team_id: { type: 'string', minLength: 1, maxLength: 256 },
    user_id: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export function billingSubjectActionBodySchema(
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  required: readonly string[] = [],
) {
  return {
    ...billingSubjectRequestJsonSchema,
    required: [...billingSubjectRequestJsonSchema.required, ...required],
    properties: { ...billingSubjectRequestJsonSchema.properties, ...properties },
  } as const;
}
