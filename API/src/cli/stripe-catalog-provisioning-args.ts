import { parseArgs } from 'node:util';

import { AppError } from '../utils/errors.js';

export type StripeCatalogCliOptions =
  | { help: true }
  | {
      help: false;
      dryRun: boolean;
      stripeAccountId: string;
      livemode: boolean;
    };

export function stripeCatalogConfirmation(stripeAccountId: string, livemode: boolean): string {
  return `PROVISION_UOA_STRIPE_CATALOG:${stripeAccountId}:${livemode ? 'live' : 'test'}`;
}

function invalidArgs(): never {
  throw new AppError('BAD_REQUEST', 400, 'STRIPE_CATALOG_PROVISIONING_ARGUMENTS_INVALID');
}

export function parseStripeCatalogCliArgs(args: string[]): StripeCatalogCliOptions {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      apply: { type: 'boolean', default: false },
      confirm: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      'stripe-account': { type: 'string' },
      'stripe-mode': { type: 'string' },
    },
  });
  if (values.help) return { help: true };
  const stripeAccountId = values['stripe-account'];
  const stripeMode = values['stripe-mode'];
  if (
    !stripeAccountId ||
    !/^acct_[A-Za-z0-9]+$/.test(stripeAccountId) ||
    (stripeMode !== 'test' && stripeMode !== 'live') ||
    values.apply === values['dry-run']
  ) {
    invalidArgs();
  }
  const livemode = stripeMode === 'live';
  if (values.apply) {
    if (values.confirm !== stripeCatalogConfirmation(stripeAccountId, livemode)) invalidArgs();
  } else if (values.confirm !== undefined) {
    invalidArgs();
  }
  return {
    help: false,
    dryRun: values['dry-run'],
    stripeAccountId,
    livemode,
  };
}
