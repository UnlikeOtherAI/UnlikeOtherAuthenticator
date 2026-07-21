type JsonSchema = Record<string, unknown>;

const nullableString = { type: ['string', 'null'] } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;

const moneySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['amount_minor', 'amount', 'currency', 'display'],
  properties: {
    amount_minor: { type: 'string', pattern: '^-?(0|[1-9]\\d*)$' },
    amount: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    display: { type: 'string' },
  },
} as const;

export const invoiceAddressResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['line1', 'city', 'postal_code', 'country'],
  properties: {
    line1: { type: 'string' },
    line2: { type: 'string' },
    city: { type: 'string' },
    region: { type: 'string' },
    postal_code: { type: 'string' },
    country: { type: 'string', pattern: '^[A-Z]{2}$' },
  },
} as const;

const issuerPartySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'profile_id',
    'legal_name',
    'trading_name',
    'billing_email',
    'address',
    'tax_identifier',
    'company_registration_number',
  ],
  properties: {
    profile_id: { type: 'string' },
    legal_name: { type: 'string' },
    trading_name: nullableString,
    billing_email: { type: 'string', format: 'email' },
    address: invoiceAddressResponseSchema,
    tax_identifier: nullableString,
    company_registration_number: nullableString,
  },
} as const;

const buyerPartySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'profile_id',
    'legal_name',
    'billing_email',
    'billing_address',
    'tax_identifier',
    'purchase_order_reference',
  ],
  properties: {
    profile_id: { type: 'string' },
    legal_name: { type: 'string' },
    billing_email: { type: 'string', format: 'email' },
    billing_address: invoiceAddressResponseSchema,
    tax_identifier: nullableString,
    purchase_order_reference: nullableString,
  },
} as const;

export const contractVersionResponseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'version',
    'usage_markup_bps',
    'usage_markup_percent',
    'currency',
    'payment_terms_days',
    'effective_from_month',
    'services',
    'actions',
    'created_at',
  ],
  properties: {
    id: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    usage_markup_bps: { type: 'integer', minimum: 0, maximum: 100000 },
    usage_markup_percent: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    payment_terms_days: { type: 'integer', minimum: 0, maximum: 365 },
    effective_from_month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'service_id',
          'service_identifier',
          'service_name',
          'tariff_id',
          'monthly_amount_minor',
          'monthly_price',
        ],
        properties: {
          service_id: { type: 'string' },
          service_identifier: nullableString,
          service_name: nullableString,
          tariff_id: { type: 'string' },
          monthly_amount_minor: { type: 'string', pattern: '^(0|[1-9]\\d*)$' },
          monthly_price: moneySchema,
        },
      },
    },
    actions: {
      type: 'object',
      additionalProperties: false,
      required: ['activation_state', 'activate'],
      properties: {
        activation_state: {
          type: 'string',
          enum: ['active', 'ready', 'scheduled', 'superseded', 'contract_terminated'],
        },
        activate: { type: 'boolean' },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const contractResponseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'organisation_id',
    'organisation_name',
    'reference',
    'name',
    'status',
    'activated_at',
    'terminated_at',
    'versions',
    'actions',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: { type: 'string' },
    organisation_id: { type: 'string' },
    organisation_name: nullableString,
    reference: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['draft', 'active', 'terminated'] },
    activated_at: nullableDateTime,
    terminated_at: nullableDateTime,
    versions: { type: 'array', items: contractVersionResponseSchema },
    actions: {
      type: 'object',
      additionalProperties: false,
      required: ['add_version'],
      properties: { add_version: { type: 'boolean' } },
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const contractArrayResponseSchema: JsonSchema = {
  type: 'array',
  items: contractResponseSchema,
};

export const issuerProfileResponseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'key',
    'legal_name',
    'trading_name',
    'billing_email',
    'address',
    'tax_identifier',
    'company_registration_number',
    'invoice_number_prefix',
    'active',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: { type: 'string' },
    key: { type: 'string' },
    legal_name: { type: 'string' },
    trading_name: nullableString,
    billing_email: { type: 'string', format: 'email' },
    address: invoiceAddressResponseSchema,
    tax_identifier: nullableString,
    company_registration_number: nullableString,
    invoice_number_prefix: { type: 'string' },
    active: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const issuerProfileArrayResponseSchema: JsonSchema = {
  type: 'array',
  items: issuerProfileResponseSchema,
};

export const buyerProfileResponseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'organisation_id',
    'legal_name',
    'billing_email',
    'billing_address',
    'tax_identifier',
    'purchase_order_reference',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: { type: 'string' },
    organisation_id: { type: 'string' },
    legal_name: { type: 'string' },
    billing_email: { type: 'string', format: 'email' },
    billing_address: invoiceAddressResponseSchema,
    tax_identifier: nullableString,
    purchase_order_reference: nullableString,
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const invoiceResponseSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'organisation_id',
    'contract_id',
    'contract_version_id',
    'billing_month',
    'revision',
    'status',
    'invoice_number',
    'issue_date',
    'due_date',
    'issued_at',
    'voided_at',
    'void_reason',
    'currency',
    'issuer',
    'buyer',
    'lines',
    'separately_billed_add_ons',
    'totals',
    'payment_status',
    'actions',
    'payments',
    'created_at',
  ],
  properties: {
    id: { type: 'string' },
    organisation_id: { type: 'string' },
    contract_id: { type: 'string' },
    contract_version_id: { type: 'string' },
    billing_month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    revision: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['draft', 'issuing', 'issued', 'void'] },
    invoice_number: nullableString,
    issue_date: nullableDateTime,
    due_date: nullableDateTime,
    issued_at: nullableDateTime,
    voided_at: nullableDateTime,
    void_reason: nullableString,
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    issuer: issuerPartySchema,
    buyer: buyerPartySchema,
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'service', 'price'],
        properties: {
          id: { type: 'string' },
          service: {
            type: 'object',
            additionalProperties: false,
            required: ['identifier', 'name'],
            properties: { identifier: { type: 'string' }, name: { type: 'string' } },
          },
          price: moneySchema,
        },
      },
    },
    separately_billed_add_ons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'service', 'offer', 'scope', 'collection', 'monthly_price', 'note'],
        properties: {
          id: { type: 'string' },
          service: {
            type: 'object',
            additionalProperties: false,
            required: ['identifier', 'name'],
            properties: { identifier: { type: 'string' }, name: { type: 'string' } },
          },
          offer: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'name'],
            properties: { key: { type: 'string' }, name: { type: 'string' } },
          },
          scope: { type: 'string', enum: ['organisation', 'team', 'subscribing_user'] },
          collection: { type: 'string', enum: ['collected_separately'] },
          monthly_price: moneySchema,
          note: {
            type: 'string',
            enum: ['Collected separately; not included in this invoice total.'],
          },
        },
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      required: [
        'subtotal',
        'tax',
        'total',
        'credits_applied',
        'paid',
        'written_off',
        'outstanding',
      ],
      properties: {
        subtotal: moneySchema,
        tax: moneySchema,
        total: moneySchema,
        credits_applied: moneySchema,
        paid: moneySchema,
        written_off: moneySchema,
        outstanding: moneySchema,
      },
    },
    payment_status: { type: 'string', enum: ['open', 'partially_paid', 'paid', 'void'] },
    actions: {
      type: 'object',
      additionalProperties: false,
      required: ['issue', 'download_pdf', 'void', 'payment_limits'],
      properties: {
        issue: { type: ['string', 'null'], enum: ['issue', 'resume_issue', null] },
        download_pdf: { type: 'boolean' },
        void: { type: 'boolean' },
        payment_limits: {
          type: 'object',
          additionalProperties: false,
          required: ['payment', 'refund', 'write_off'],
          properties: {
            payment: { anyOf: [moneySchema, { type: 'null' }] },
            refund: { anyOf: [moneySchema, { type: 'null' }] },
            write_off: { anyOf: [moneySchema, { type: 'null' }] },
          },
        },
      },
    },
    payments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'source', 'amount', 'reference', 'occurred_at', 'recorded_at'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['payment', 'refund', 'write_off'] },
          source: { type: 'string', enum: ['manual'] },
          amount: moneySchema,
          reference: nullableString,
          occurred_at: { type: 'string', format: 'date-time' },
          recorded_at: { type: 'string', format: 'date-time' },
        },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const invoiceArraySchema: JsonSchema = {
  type: 'array',
  items: invoiceResponseSchema,
};
