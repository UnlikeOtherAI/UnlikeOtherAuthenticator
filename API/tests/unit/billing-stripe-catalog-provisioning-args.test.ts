import { describe, expect, it } from 'vitest';

import {
  parseStripeCatalogCliArgs,
  stripeCatalogConfirmation,
} from '../../src/cli/stripe-catalog-provisioning-args.js';

const account = 'acct_123456';

describe('Stripe commercial catalog operator arguments', () => {
  it('accepts an explicit read-only dry run', () => {
    expect(
      parseStripeCatalogCliArgs([
        '--dry-run',
        '--stripe-account',
        account,
        '--stripe-mode',
        'test',
      ]),
    ).toEqual({ help: false, dryRun: true, stripeAccountId: account, livemode: false });
  });

  it('requires the exact account-and-mode confirmation before apply', () => {
    const confirmation = stripeCatalogConfirmation(account, true);
    expect(
      parseStripeCatalogCliArgs([
        '--apply',
        '--stripe-account',
        account,
        '--stripe-mode',
        'live',
        '--confirm',
        confirmation,
      ]),
    ).toEqual({ help: false, dryRun: false, stripeAccountId: account, livemode: true });
  });

  it.each([
    [[]],
    [['--apply', '--stripe-account', account, '--stripe-mode', 'live']],
    [
      [
        '--apply',
        '--stripe-account',
        account,
        '--stripe-mode',
        'live',
        '--confirm',
        stripeCatalogConfirmation(account, false),
      ],
    ],
    [['--dry-run', '--apply', '--stripe-account', account, '--stripe-mode', 'test']],
  ])('rejects ambiguous or unconfirmed mutation arguments: %j', (args) => {
    expect(() => parseStripeCatalogCliArgs(args)).toThrow(
      'STRIPE_CATALOG_PROVISIONING_ARGUMENTS_INVALID',
    );
  });
});
