import { BillingCreditEntryDirection, BillingCreditEntryKind } from '@prisma/client';

import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
} from '../contracts/billing-statement-v1.js';
import { billingCreditAmount } from './billing-credit-display.service.js';
import type { BillingCreditProjectionData } from './billing-credit-projection-data.service.js';

function entryCopy(kind: BillingCreditEntryKind, serviceName: string | null, credits: string) {
  const product = serviceName ?? 'Team';
  switch (kind) {
    case BillingCreditEntryKind.TOP_UP:
      return {
        label: `Team credits added from ${product}`,
        detail: `A verified payment added ${credits} shared team credits.`,
      };
    case BillingCreditEntryKind.AUTOMATIC_TOP_UP:
      return {
        label: 'Automatic team credit top-up',
        detail: `A verified automatic payment added ${credits} shared team credits.`,
      };
    case BillingCreditEntryKind.USAGE_SETTLEMENT:
      return {
        label: `${product} usage`,
        detail: `${credits} credits were consumed by team-rated ${product} usage; see the usage breakdown.`,
      };
    case BillingCreditEntryKind.USAGE_SETTLEMENT_CORRECTION:
      return {
        label: `${product} usage correction`,
        detail: `The verified ${product} usage snapshot changed the shared balance by ${credits} credits.`,
      };
    case BillingCreditEntryKind.REFUND:
      return {
        label: `${product} payment refund`,
        detail: `A verified refund removed ${credits} credits from the shared team balance.`,
      };
    case BillingCreditEntryKind.DISPUTE:
      return {
        label: `${product} payment dispute`,
        detail: `A verified payment dispute removed ${credits} credits from the shared team balance.`,
      };
    case BillingCreditEntryKind.ADJUSTMENT:
      return {
        label: 'Account credit adjustment',
        detail: `UOA support adjusted the shared team balance by ${credits} credits.`,
      };
  }
}

function commonEntry(entry: BillingCreditProjectionData['entries'][number]) {
  const amount = billingCreditAmount(entry.amountMicrocredits);
  return {
    id: entry.id,
    occurred_at: entry.occurredAt.toISOString(),
    service: entry.service
      ? { id: entry.service.id, identifier: entry.service.identifier, name: entry.service.name }
      : null,
    kind: entry.kind.toLowerCase() as Lowercase<BillingCreditEntryKind>,
    direction:
      entry.direction === BillingCreditEntryDirection.CREDIT
        ? ('credit' as const)
        : ('debit' as const),
    ...entryCopy(entry.kind, entry.service?.name ?? null, amount.credits),
    credits: amount,
    credit_balance_after: billingCreditAmount(entry.balanceAfterMicrocredits),
  };
}

function nullAttribution(kind: BillingCreditEntryKind) {
  if (kind === BillingCreditEntryKind.ADJUSTMENT) return 'system' as const;
  if (
    kind === BillingCreditEntryKind.USAGE_SETTLEMENT ||
    kind === BillingCreditEntryKind.USAGE_SETTLEMENT_CORRECTION
  ) {
    return 'team_aggregate' as const;
  }
  return 'unattributed' as const;
}

export function buildManagerCreditRecentEntries(
  data: BillingCreditProjectionData,
): BillingCreditsManagerV1['recent_entries'] {
  return data.entries.map((entry) => ({
    ...commonEntry(entry),
    attribution: entry.attributedUserId
      ? {
          kind: 'user',
          user_id: entry.attributedUserId,
          display_name: entry.attributedUser?.name ?? 'Team member',
        }
      : { kind: nullAttribution(entry.kind) },
  }));
}

export function buildMemberCreditRecentEntries(
  data: BillingCreditProjectionData,
  viewerId: string,
): BillingCreditsMemberV1['recent_entries'] {
  return data.entries.map((entry) => ({
    ...commonEntry(entry),
    attribution: entry.attributedUserId === viewerId
      ? 'viewer'
      : entry.attributedUserId
        ? 'other_team_members'
        : nullAttribution(entry.kind),
  }));
}
