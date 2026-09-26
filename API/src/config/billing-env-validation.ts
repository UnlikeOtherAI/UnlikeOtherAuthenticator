import { z } from 'zod';

import {
  privateRs256JwkKeyId,
  privateRs256JwkMatchesPublicJwks,
  publicRs256JwkKeyIds,
} from '../utils/rs256-jwk.js';
import { normalizeBoolean } from './env-boolean.js';

export const billingEnvShape = {
  // Stripe is an explicitly gated payment processor. Keys may be provisioned
  // ahead of launch, but no customer, Checkout, subscription, or meter call is
  // permitted until the gate is enabled and both credentials are present.
  STRIPE_BILLING_ENABLED: z.preprocess(normalizeBoolean, z.boolean().default(false)),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_USAGE_EXPORT_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(1),
  STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES: z.coerce.number().int().min(5).max(1440).default(360),
  STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES: z.coerce.number().int().min(1).max(60).default(1),
  // UOA pulls immutable monthly snapshots from Ledger with UOA's own
  // product-bound Ledger app key and a separately signed service assertion.
  LEDGER_BILLING_BASE_URL: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      );
    }, 'LEDGER_BILLING_BASE_URL must be a credential-free HTTPS URL')
    .optional(),
  LEDGER_BILLING_APP_KEY: z
    .string()
    .regex(/^lk_[A-Za-z0-9_-]{16,}$/)
    .optional(),
  LEDGER_BILLING_APP_KEY_ID: z
    .string()
    .regex(/^tk_[A-Za-z0-9_-]{3,253}$/)
    .optional(),
  LEDGER_BILLING_ASSERTION_AUDIENCE: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      );
    }, 'LEDGER_BILLING_ASSERTION_AUDIENCE must be a credential-free HTTPS origin')
    .optional(),
  UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK: z
    .string()
    .min(1)
    .refine((value) => privateRs256JwkKeyId(value) !== undefined, {
      message:
        'UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK must be a private RS256 RSA JWK with a kid',
    })
    .optional(),
  // Public current + retired verification keys for UOA's Ledger collector
  // assertion. This is a separate trust surface from tariff snapshots and
  // resource-token signing.
  UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON: z
    .string()
    .min(1)
    .refine((value) => publicRs256JwkKeyIds(value) !== undefined, {
      message: 'UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON must contain public-only RS256 RSA keys',
    })
    .optional(),
  // Relying-party actor assertions (`X-UOA-Actor`) must name the exact billing
  // endpoint they are presented to in `aud`. Products that still pin one legacy
  // audience for every endpoint are accepted under "warn" (the transition default)
  // and logged; "enforce" refuses them with BILLING_ACTOR_AUDIENCE_MISMATCH.
  // See Docs/Auth/billing-actor-assertions.md.
  BILLING_ACTOR_AUDIENCE_MODE: z.enum(['warn', 'enforce']).default('warn'),
  // Private immutable PDFs for manually issued contract invoices. Contract
  // calculation remains available when disabled, but issuance fails closed.
  BILLING_INVOICE_STORAGE_PROVIDER: z.enum(['disabled', 'filesystem', 'gcs']).default('disabled'),
  BILLING_INVOICE_FILESYSTEM_ROOT: z.string().min(1).optional(),
  BILLING_INVOICE_GCS_BUCKET: z.string().min(1).optional(),
  BILLING_INVOICE_GCS_PROJECT_ID: z.string().min(1).optional(),
};

type BillingEnvironment = {
  TARIFF_SNAPSHOT_PRIVATE_JWK?: string;
  TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON?: string;
  STRIPE_BILLING_ENABLED: boolean;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_USAGE_EXPORT_INTERVAL_MINUTES: number;
  STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES: number;
  STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES: number;
  LEDGER_BILLING_BASE_URL?: string;
  LEDGER_BILLING_APP_KEY?: string;
  LEDGER_BILLING_APP_KEY_ID?: string;
  LEDGER_BILLING_ASSERTION_AUDIENCE?: string;
  UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK?: string;
  UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON?: string;
};

function addKeyPairIssues(
  ctx: z.RefinementCtx,
  params: {
    privateKey?: string;
    publicJwks?: string;
    privatePath: string;
    publicPath: string;
    pairMessage: string;
    mismatchMessage: string;
  },
): void {
  if (Boolean(params.privateKey) !== Boolean(params.publicJwks)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [params.privateKey ? params.publicPath : params.privatePath],
      message: params.pairMessage,
    });
  }
  if (
    params.privateKey &&
    params.publicJwks &&
    !privateRs256JwkMatchesPublicJwks(params.privateKey, params.publicJwks)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [params.publicPath],
      message: params.mismatchMessage,
    });
  }
}

export function addBillingEnvironmentIssues(env: BillingEnvironment, ctx: z.RefinementCtx): void {
  addKeyPairIssues(ctx, {
    privateKey: env.TARIFF_SNAPSHOT_PRIVATE_JWK,
    publicJwks: env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON,
    privatePath: 'TARIFF_SNAPSHOT_PRIVATE_JWK',
    publicPath: 'TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON',
    pairMessage: 'tariff snapshot private key and public JWKS must be configured together',
    mismatchMessage: 'tariff snapshot public JWKS must include the current private key public pair',
  });
  addKeyPairIssues(ctx, {
    privateKey: env.UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK,
    publicJwks: env.UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON,
    privatePath: 'UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK',
    publicPath: 'UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON',
    pairMessage: 'UOA billing assertion private key and public JWKS must be configured together',
    mismatchMessage:
      'UOA billing assertion public JWKS must include the current private key public pair',
  });

  if (
    env.STRIPE_BILLING_ENABLED &&
    (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [!env.STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET'],
      message:
        'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when Stripe billing is enabled',
    });
  }
  if (Boolean(env.STRIPE_SECRET_KEY) !== Boolean(env.STRIPE_WEBHOOK_SECRET)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [!env.STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET'],
      message:
        'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must remain configured together for webhook reconciliation',
    });
  }
  if (
    env.STRIPE_SECRET_KEY &&
    !/^(?:sk|rk)_(?:test|live)_/.test(env.STRIPE_SECRET_KEY)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STRIPE_SECRET_KEY'],
      message: 'STRIPE_SECRET_KEY must identify an explicit Stripe test or live mode',
    });
  }
  if (!env.STRIPE_BILLING_ENABLED) return;

  if (
    env.STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES <
    env.STRIPE_USAGE_EXPORT_INTERVAL_MINUTES + env.STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES'],
      message:
        'STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES must cover the export interval plus safety offset',
    });
  }

  const collectorFields = [
    'LEDGER_BILLING_BASE_URL',
    'LEDGER_BILLING_APP_KEY',
    'LEDGER_BILLING_APP_KEY_ID',
    'LEDGER_BILLING_ASSERTION_AUDIENCE',
    'UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK',
    'UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON',
  ] as const;
  const missing = collectorFields.find((field) => !env[field]);
  if (missing) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [missing],
      message: `${missing} is required when Stripe billing is enabled`,
    });
  }
}

type BillingInvoiceStorageEnvironment = {
  NODE_ENV: string;
  BILLING_INVOICE_STORAGE_PROVIDER: 'disabled' | 'filesystem' | 'gcs';
  BILLING_INVOICE_FILESYSTEM_ROOT?: string;
  BILLING_INVOICE_GCS_BUCKET?: string;
};

export function addBillingInvoiceStorageIssues(
  env: BillingInvoiceStorageEnvironment,
  ctx: z.RefinementCtx,
): void {
  if (
    env.BILLING_INVOICE_STORAGE_PROVIDER === 'filesystem' &&
    !env.BILLING_INVOICE_FILESYSTEM_ROOT
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BILLING_INVOICE_FILESYSTEM_ROOT'],
      message: 'BILLING_INVOICE_FILESYSTEM_ROOT is required for filesystem invoice storage',
    });
  }
  if (env.BILLING_INVOICE_STORAGE_PROVIDER === 'filesystem' && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BILLING_INVOICE_STORAGE_PROVIDER'],
      message: 'filesystem invoice storage is not allowed in production',
    });
  }
  if (env.BILLING_INVOICE_STORAGE_PROVIDER === 'gcs' && !env.BILLING_INVOICE_GCS_BUCKET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BILLING_INVOICE_GCS_BUCKET'],
      message: 'BILLING_INVOICE_GCS_BUCKET is required for GCS invoice storage',
    });
  }
}
