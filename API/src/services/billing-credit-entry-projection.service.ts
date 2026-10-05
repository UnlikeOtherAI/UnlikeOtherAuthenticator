import { BillingCreditEntryDirection, BillingCreditEntryKind } from '@prisma/client';

import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
} from '../contracts/billing-statement-v1.js';
import { billingCreditAmount } from './billing-credit-display.service.js';
import { billingCreditCopy, billingLocalizedCreditDisplay } from './billing-credit-copy.catalog.js';
import { formatBillingCreditEntryCopy } from './billing-credit-entry-copy.catalog.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import type { BillingCreditProjectionData } from './billing-credit-projection-data.service.js';

function commonEntry(
  entry: BillingCreditProjectionData['entries'][number],
  locale?: BillingCustomerLocale,
) {
  const amount = billingCreditAmount(entry.amountMicrocredits, locale);
  return {
    id: entry.id,
    occurred_at: entry.occurredAt.toISOString(),
    service: entry.service
      ? { id: entry.service.id, identifier: entry.service.identifier, name: entry.service.name }
      : null,
    kind: (entry.kind === BillingCreditEntryKind.PREPAID_USAGE
      ? 'usage_settlement' : entry.kind.toLowerCase()) as Exclude<
        Lowercase<BillingCreditEntryKind>, 'prepaid_usage'>,
    direction:
      entry.direction === BillingCreditEntryDirection.CREDIT
        ? ('credit' as const)
        : ('debit' as const),
    ...formatBillingCreditEntryCopy(entry.kind, locale, {
      product: entry.service?.name ?? billingCreditCopy(locale).teamName,
      credits: billingLocalizedCreditDisplay(amount.credits, locale),
    }),
    credits: { ...amount, display: billingLocalizedCreditDisplay(amount.credits, locale) },
    credit_balance_after: {
      ...billingCreditAmount(entry.balanceAfterMicrocredits, locale),
      display: billingLocalizedCreditDisplay(billingCreditAmount(entry.balanceAfterMicrocredits, locale).credits, locale),
    },
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
  locale?: BillingCustomerLocale,
): BillingCreditsManagerV1['recent_entries'] {
  return data.entries
    .filter((entry) => entry.amountMicrocredits > 0n)
    .map((entry) => ({
      ...commonEntry(entry, locale),
      attribution: entry.attributedUserId
        ? {
            kind: 'user',
            user_id: entry.attributedUserId,
            display_name: entry.attributedUser?.name ?? billingCreditCopy(locale).teamMember,
          }
        : { kind: nullAttribution(entry.kind) },
    }));
}

export function buildMemberCreditRecentEntries(
  data: BillingCreditProjectionData,
  viewerId: string,
  locale?: BillingCustomerLocale,
): BillingCreditsMemberV1['recent_entries'] {
  return data.entries
    .filter((entry) => entry.amountMicrocredits > 0n)
    .map((entry) => ({
      ...commonEntry(entry, locale),
      attribution:
        entry.attributedUserId === viewerId
          ? 'viewer'
          : entry.attributedUserId
            ? 'other_team_members'
            : nullAttribution(entry.kind),
    }));
}
