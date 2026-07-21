import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

import {
  STRIPE_BILLING_API_VERSION,
  stripeSecretKeyLivemode,
} from '../services/billing-stripe-client.service.js';
import { provisionStripeCommercialCatalog } from '../services/billing-stripe-catalog-provisioning.service.js';
import { AppError, isAppError } from '../utils/errors.js';
import { parseStripeCatalogCliArgs } from './stripe-catalog-provisioning-args.js';
import { resolveStripeCatalogDatabaseUrl } from './stripe-catalog-provisioning-runtime.js';

function usage(): string {
  return `Usage:
  pnpm billing:provision-stripe-catalog --dry-run --stripe-account acct_... --stripe-mode test|live
  pnpm billing:provision-stripe-catalog --apply --stripe-account acct_... --stripe-mode test|live \\
    --confirm 'PROVISION_UOA_STRIPE_CATALOG:acct_...:<test|live>'

The apply confirmation must use the exact account and mode selected above.
The command reads STRIPE_SECRET_KEY and DATABASE_ADMIN_URL (or DATABASE_URL).`;
}

function safeErrorCode(error: unknown): string {
  if (isAppError(error) && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'STRIPE_CATALOG_PROVISIONING_FAILED';
}

async function main(): Promise<void> {
  const options = parseStripeCatalogCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new AppError('INTERNAL', 503, 'STRIPE_SECRET_KEY_REQUIRED');
  }
  const actualLivemode = stripeSecretKeyLivemode(secretKey);
  if (actualLivemode !== options.livemode) {
    throw new AppError('INTERNAL', 409, 'STRIPE_COMMERCIAL_CATALOG_MODE_MISMATCH');
  }
  const prisma = new PrismaClient({
    datasources: { db: { url: resolveStripeCatalogDatabaseUrl(process.env) } },
  });
  const stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_BILLING_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  try {
    const result = await provisionStripeCommercialCatalog(
      {
        stripe,
        expectedStripeAccountId: options.stripeAccountId,
        expectedLivemode: options.livemode,
        dryRun: options.dryRun,
      },
      { prisma },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: safeErrorCode(error) })}\n`);
  process.exitCode = 1;
});
