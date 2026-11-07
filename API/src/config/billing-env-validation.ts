import { z } from 'zod';

import { privateRs256JwkMatchesPublicJwks } from '../utils/rs256-jwk.js';

type BillingEnvironment = {
  TARIFF_SNAPSHOT_PRIVATE_JWK?: string;
  TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON?: string;
  STRIPE_BILLING_ENABLED: boolean;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_LIVE_SECRET_KEY?: string;
  STRIPE_LIVE_WEBHOOK_SECRET?: string;
  STRIPE_LIVE_ACCOUNT_ID?: string;
  STRIPE_SANDBOX_SECRET_KEY?: string;
  STRIPE_SANDBOX_WEBHOOK_SECRET?: string;
  STRIPE_SANDBOX_ACCOUNT_ID?: string;
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
  for (const mode of ['LIVE', 'SANDBOX'] as const) {
    const fields = [`STRIPE_${mode}_SECRET_KEY`, `STRIPE_${mode}_WEBHOOK_SECRET`,
      `STRIPE_${mode}_ACCOUNT_ID`] as const;
    if (fields.some((field) => Boolean(env[field])) && fields.some((field) => !env[field])) {
      ctx.addIssue({ code: 'custom', path: [fields.find((field) => !env[field])!],
        message: `${fields.join(', ')} must be configured together` });
    }
    const key = env[`STRIPE_${mode}_SECRET_KEY`];
    if (key && !(mode === 'LIVE' ? /^(?:sk|rk)_live_/ : /^(?:sk|rk)_test_/).test(key)) {
      ctx.addIssue({ code: 'custom', path: [`STRIPE_${mode}_SECRET_KEY`],
        message: `Stripe ${mode.toLowerCase()} key has the wrong mode` });
    }
  }
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
    (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) &&
    (!env.STRIPE_LIVE_SECRET_KEY || !env.STRIPE_LIVE_WEBHOOK_SECRET)
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
