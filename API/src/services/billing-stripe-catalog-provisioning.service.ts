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
  /** `changed` when the run creates or retires anything; `no-op` when every row is already exact. */
  outcome: 'changed' | 'no-op';
  stripe: {
    account_id: string;
    livemode: boolean;
  };
  summary: {
    created: number;
    retired: number;
    skipped: number;
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
  const count = (outcome: CatalogProvisioningAction['outcome']) =>
    actions.filter((action) => action.outcome === outcome).length;
  const created = count('created');
  const retired = count('retired');
  return {
    mode: params.dryRun ? 'dry-run' : 'apply',
    outcome: created + retired > 0 ? 'changed' : 'no-op',
    stripe: {
      account_id: catalog.stripeAccountId,
      livemode: catalog.livemode,
    },
    summary: {
      created,
      retired,
      skipped: count('skipped'),
      no_op: count('no-op'),
    },
    actions,
  };
}
