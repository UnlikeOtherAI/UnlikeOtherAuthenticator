import { BillingCollectionMode, BillingTariffMode } from '@prisma/client';

import type { PublicBillingCollectionMode, PublicTariffMode } from './billing-tariff.service.js';

export function billingModeToPublic(mode: BillingTariffMode): PublicTariffMode {
  const modes: Record<BillingTariffMode, PublicTariffMode> = {
    [BillingTariffMode.STANDARD]: 'standard',
    [BillingTariffMode.FREE]: 'free',
    [BillingTariffMode.AT_COST]: 'at_cost',
    [BillingTariffMode.CUSTOM]: 'custom',
  };
  return modes[mode];
}

export function billingCollectionModeToPublic(
  mode: BillingCollectionMode,
): PublicBillingCollectionMode {
  const modes: Record<BillingCollectionMode, PublicBillingCollectionMode> = {
    [BillingCollectionMode.STRIPE]: 'stripe',
    [BillingCollectionMode.MANUAL]: 'manual',
    [BillingCollectionMode.NONE]: 'none',
  };
  return modes[mode];
}
