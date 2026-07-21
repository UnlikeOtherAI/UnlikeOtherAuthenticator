import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import {
  type CatalogProvisioningAction,
  reconcileLocalStripeCommercialCatalog,
} from './billing-stripe-catalog-provisioning-local.service.js';
import {
  type StripeCatalogProvisioningClient,
  validateStripeCommercialCatalog,
} from './billing-stripe-catalog-provisioning-remote.service.js';

export type StripeCatalogProvisioningResult = {
  mode: 'apply' | 'dry-run';
  outcome: 'created' | 'no-op';
  stripe: {
    account_id: string;
    livemode: boolean;
  };
  summary: {
    created: number;
    no_op: number;
  };
  actions: CatalogProvisioningAction[];
};

export async function provisionStripeCommercialCatalog(
  params: {
    stripe: StripeCatalogProvisioningClient;
    expectedStripeAccountId: string;
    expectedLivemode: boolean;
    dryRun: boolean;
  },
  deps?: {
    prisma?: PrismaClient;
    validateRemote?: typeof validateStripeCommercialCatalog;
    reconcileLocal?: typeof reconcileLocalStripeCommercialCatalog;
  },
): Promise<StripeCatalogProvisioningResult> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const catalog = await (deps?.validateRemote ?? validateStripeCommercialCatalog)({
    stripe: params.stripe,
    expectedStripeAccountId: params.expectedStripeAccountId,
    expectedLivemode: params.expectedLivemode,
  });
  const reconcile = deps?.reconcileLocal ?? reconcileLocalStripeCommercialCatalog;
  const actions = params.dryRun
    ? await reconcile({ db: prisma, catalog, write: false })
    : await prisma.$transaction((tx) => reconcile({ db: tx, catalog, write: true }), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
  const created = actions.filter((action) => action.outcome === 'created').length;
  return {
    mode: params.dryRun ? 'dry-run' : 'apply',
    outcome: created > 0 ? 'created' : 'no-op',
    stripe: {
      account_id: catalog.stripeAccountId,
      livemode: catalog.livemode,
    },
    summary: {
      created,
      no_op: actions.length - created,
    },
    actions,
  };
}
