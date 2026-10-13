import { Prisma } from '@prisma/client';
import { expect, it } from 'vitest';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import { deepwaterCredential, handle, ids, line, portfolio } from '../helpers/credit-settlement-fixture.js';

export function registerAcceptedStripeFundingCase() {
  it('does not consume a later top-up for an accepted Stripe charge but funds new usage', async () => {
    if (!handle) throw new Error('db handle missing');
    const teamId = 'team_credit_export_cap';
    const customerId = 'bsc_credit_export_cap';
    const creditAccountId = 'bca_credit_export_cap';
    const subscriptionId = 'bss_credit_export_cap';
    await handle.prisma.team.create({
      data: { id: teamId, orgId: ids.org, name: 'Export Cap Team', slug: 'export-cap' },
    });
    await handle.prisma.teamMember.create({
      data: { id: 'tm_credit_export_cap', teamId, userId: ids.owner, teamRole: 'owner' },
    });
    await handle.prisma.billingStripeCustomer.create({
      data: {
        id: customerId, accountId: ids.account, orgId: ids.org, teamId,
        scope: 'TEAM', scopeKey: `${ids.org}:${teamId}`,
        stripeCustomerId: 'cus_credit_export_cap',
      },
    });
    await handle.prisma.billingCreditAccount.create({
      data: {
        id: creditAccountId, accountId: ids.account, customerId, orgId: ids.org,
        teamId, scope: 'TEAM', scopeKey: `${ids.org}:${teamId}`, currency: 'USD',
      },
    });
    const checkout = await handle.prisma.billingStripeCheckoutSession.create({
      data: {
        id: 'bsch_credit_export_cap', accountId: ids.account, appKeyId: ids.deepwaterKey,
        customerId, serviceId: ids.deepwater, tariffId: ids.deepwaterTariff,
        tariffSource: 'SERVICE_DEFAULT', orgId: ids.org, teamId,
        scope: 'TEAM', scopeKey: `${ids.org}:${teamId}`,
        actorJti: 'credit-export-cap', requestedByUserId: ids.owner,
        successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
        leaseExpiresAt: new Date('2026-10-04T12:00:00.000Z'),
      },
    });
    await handle.prisma.billingStripeSubscription.create({
      data: {
        id: subscriptionId, accountId: ids.account, checkoutId: checkout.id,
        customerId, serviceId: ids.deepwater, tariffId: ids.deepwaterTariff,
        tariffSource: 'SERVICE_DEFAULT', orgId: ids.org, teamId,
        scope: 'TEAM', scopeKey: `${ids.org}:${teamId}`,
        stripeSubscriptionId: 'sub_credit_export_cap', stripeUsageItemId: 'si_credit_export_cap',
        status: 'active', livemode: false,
      },
    });
    const october = (cursor: string, capturedAt: string, cost: string) => {
      const result = portfolio(cursor, capturedAt, [line('deepwater', ids.owner, cost)]);
      result.scope = {
        ...result.scope, teamId, month: '2026-10',
        startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z',
      };
      return result;
    };
    await settleCreditPortfolio({
      creditAccountId,
      portfolio: october('mup_export_cap_first_1234567890123456', '2026-10-04T10:00:00.000Z', '1.3'),
      credential: deepwaterCredential,
    }, { prisma: handle.prisma });
    await handle.prisma.billingStripeUsageExport.create({
      data: {
        accountId: ids.account, subscriptionId,
        ledgerSnapshotCursor: 'bus_export_cap_first_1234567890123456',
        billingMonth: '2026-10', billingProduct: 'deepwater', callerProduct: 'deepwater',
        currency: 'USD', cumulativeCustomerCharge: '1.3',
        cumulativeGrossMeterQuantity: 130_000_000n,
        cumulativeMeterQuantity: 130_000_000n, deltaMeterQuantity: 130_000_000n,
        stripeMeterEventIdentifier: 'uoa_me_export_cap_first',
        stripeMeterEventCreatedAt: new Date('2026-10-04T10:02:00.000Z'),
        stripeMeterEventState: 'ACCEPTED',
        stripeMeterEventFirstAttemptedAt: new Date('2026-10-04T10:01:00.000Z'),
        stripeMeterEventAttemptedAt: new Date('2026-10-04T10:01:00.000Z'),
        createdAt: new Date('2026-10-04T10:00:00.000Z'),
      },
    });
    const adminDomain = 'credit-export-admin.example.test';
    await handle.prisma.domainRole.create({
      data: { domain: adminDomain, userId: ids.owner, role: 'SUPERUSER' },
    });
    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT set_config('app.admin_auth_domain', ${adminDomain}, true)
      `);
      await tx.billingCreditAdminAdjustment.create({
        data: {
          id: 'bcaa_credit_export_cap', accountId: ids.account, creditAccountId,
          orgId: ids.org, teamId, signedAmountMicrocredits: 1_300_000_000n,
          reason: 'Verified credit funding fixture', idempotencyKey: 'credit-export-cap-topup',
          createdByUserId: ids.owner, createdByEmail: 'credit-owner@example.com',
          createdByAdminDomain: adminDomain, creditEntryId: 'bce_credit_export_cap',
        },
      });
      await tx.billingCreditEntry.create({
        data: {
          id: 'bce_credit_export_cap', creditAccountId,
          direction: 'CREDIT', kind: 'ADJUSTMENT', amountMicrocredits: 1_300_000_000n,
          balanceAfterMicrocredits: 1_300_000_000n,
          idempotencyKey: 'credit-export-cap-topup', sourceType: 'credit_admin_adjustment',
          sourceId: 'bcaa_credit_export_cap', occurredAt: new Date('2026-10-04T10:02:30.000Z'),
        },
      });
    });
    await settleCreditPortfolio({
      creditAccountId,
      portfolio: october('mup_export_cap_same_12345678901234567', '2026-10-04T10:03:00.000Z', '1.3'),
      credential: deepwaterCredential,
    }, { prisma: handle.prisma });
    let settlement = await handle.prisma.billingCreditUsageSettlement.findFirstOrThrow({
      where: { creditAccountId, serviceId: ids.deepwater, billingMonth: '2026-10' },
    });
    expect(settlement.cumulativeCreditsConsumedMicrocredits).toBe(0n);
    await settleCreditPortfolio({
      creditAccountId,
      portfolio: october('mup_export_cap_more_12345678901234567', '2026-10-04T10:04:00.000Z', '2.6'),
      credential: deepwaterCredential,
    }, { prisma: handle.prisma });
    settlement = await handle.prisma.billingCreditUsageSettlement.findUniqueOrThrow({
      where: { id: settlement.id },
    });
    expect(settlement.cumulativeCreditsConsumedMicrocredits).toBe(1_300_000_000n);
    expect((await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: creditAccountId },
    })).balanceMicrocredits).toBe(0n);
  });
}

export function registerOrganisationPayerTeamsCase() {
  it('keeps two source teams separate while debiting their shared organisation payer', async () => {
    if (!handle) throw new Error('db handle missing');
    const secondTeam = 'team_credit_settlement_other';
    const orgCustomer = 'bsc_credit_settlement_org';
    const orgAccount = 'bca_credit_settlement_org';
    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
        VALUES (${secondTeam}, ${ids.org}, 'Second Team', 'second-team', CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "team_members" ("id", "team_id", "user_id", "team_role", "status", "updated_at")
        VALUES ('tm_credit_settlement_other', ${secondTeam}, ${ids.second}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_stripe_customers"
          ("id", "account_id", "org_id", "scope", "scope_key", "updated_at")
        VALUES (${orgCustomer}, ${ids.account}, ${ids.org}, 'ORGANISATION', ${ids.org}, CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_credit_accounts"
          ("id", "account_id", "customer_id", "org_id", "scope", "scope_key", "currency",
           "balance_microcredits", "updated_at")
        VALUES (${orgAccount}, ${ids.account}, ${orgCustomer}, ${ids.org}, 'ORGANISATION',
          ${ids.org}, 'USD', 2000000000, CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_org_responsibilities"
          ("id", "org_id", "active", "assumed_at", "assumed_by_user_id", "created_at", "updated_at")
        VALUES ('bor_credit_settlement_org', ${ids.org}, true,
          '2026-06-01T00:00:00.000Z', ${ids.owner},
          '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_org_responsibility_transitions"
          ("id", "responsibility_id", "org_id", "kind", "effective_at", "actor_user_id", "source")
        VALUES ('bort_credit_settlement_org', 'bor_credit_settlement_org', ${ids.org},
          'ASSUMED', '2026-06-01T00:00:00.000Z', ${ids.owner}, 'legacy_backfill')
      `);
    });
    await handle.prisma.billingTariff.create({
      data: {
        id: 'tariff_credit_settlement_org_30', serviceId: ids.deepwater,
        key: 'org_standard', version: 1, name: 'Organisation standard 30%',
        mode: 'STANDARD', collectionMode: 'NONE', markupBps: 3000, currency: 'USD', usageCurrency: 'USD',
      },
    });
    await handle.prisma.billingTariffAssignment.create({
      data: {
        serviceId: ids.deepwater, tariffId: 'tariff_credit_settlement_org_30',
        orgId: ids.org, teamId: null, scope: 'ORGANISATION', scopeKey: ids.org,
      },
    });
    await handle.prisma.billingTariffTermEvent.create({
      data: { serviceId: ids.deepwater, source: 'ORGANISATION', scopeKey: ids.org,
        effectiveFromMonth: '2026-07', tariffId: 'tariff_credit_settlement_org_30',
        reason: 'test-fixture' },
    });
    const first = portfolio('mup_org_team_a_123456789012345678901234',
      '2026-07-21T13:00:00.000Z', [line('deepwater', ids.owner, '1')]);
    const second = portfolio('mup_org_team_b_123456789012345678901234',
      '2026-07-21T12:00:00.000Z', [line('deepwater', ids.second, '0.2')]);
    second.scope.teamId = secondTeam;
    await settleCreditPortfolio(
      { creditAccountId: orgAccount, portfolio: first, credential: deepwaterCredential },
      { prisma: handle.prisma },
    );
    await settleCreditPortfolio(
      { creditAccountId: orgAccount, portfolio: second, credential: deepwaterCredential },
      { prisma: handle.prisma },
    );
    const settlements = await handle.prisma.billingCreditUsageSettlement.findMany({
      where: { creditAccountId: orgAccount },
      orderBy: { teamId: 'asc' },
    });
    expect(settlements).toHaveLength(2);
    expect(new Set(settlements.map((row) => row.teamId))).toEqual(new Set([ids.team, secondTeam]));
    expect(settlements.reduce((sum, row) => sum + row.cumulativeCreditsConsumedMicrocredits, 0n))
      .toBe(1_560_000_000n);
    const payer = await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: orgAccount },
    });
    expect(payer.balanceMicrocredits).toBe(440_000_000n);
  });
}
