import {
  BillingAdjustmentCadence,
  BillingAdjustmentKind,
} from '@prisma/client';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';

import { billingStatementV1JsonSchema } from '../../src/contracts/billing-statement-v1.js';
import { now,credential,request,summary,effectiveTerm,metering } from './billing-statement-arithmetic.test-fixtures.js';
import { getCanonicalBillingStatement } from '../../src/services/billing-statement.service.js';

// These retained projection arithmetic tests do not prove public admission.
// Superseded HTTP reads refuse; current ORG authority is covered by signed PG HTTP.
vi.mock('../../src/services/billing-financial-authority.service.js',()=>({
  requireBillingManager:vi.fn().mockResolvedValue({billingManager:true}),
}));
vi.mock('../../src/services/billing-organisation-history.service.js',async()=>({
  ...await vi.importActual<typeof import('../../src/services/billing-organisation-history.service.js')>('../../src/services/billing-organisation-history.service.js'),
  organisationHistoryAccount:vi.fn().mockResolvedValue({id:'projection-account',stripeAccountId:'acct_projection',livemode:false}),
}));

describe('canonical UOA billing statement', () => {
  it('uses a frozen seat quote for a closed period, leaving the plan price labelled per seat', async () => {
    const quoteSubscription = vi.fn().mockResolvedValue({
      serviceId: 'service_deepwater', teamId: 'team_1', currency: 'GBP',
      amountMinor: 3000n,
    });
    const perSeatTerm = { ...effectiveTerm, tariff: { ...effectiveTerm.tariff,
      monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'FIXED', seatChargeTiming: 'PRORATED',
    } };
    const prisma = {
      billingService: {
        findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-01' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      billingTariffTermEvent: { findFirst: vi.fn().mockResolvedValue(perSeatTerm) },
      billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([]) },
      billingCommercialAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
      teamMember: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const statement = await getCanonicalBillingStatement(
      { request, actorToken: 'signed-actor', credential, billingMonth: '2026-07' },
      { prisma: prisma as never, now: () => new Date('2026-08-15T00:00:00.000Z'),
        resolveSummary: vi.fn().mockResolvedValue(summary) as never,
        fetchMetering: vi.fn(async (params: { groupBy: 'service' | 'user' }) =>
          metering(params.groupBy)) as never,
        listDirectAccess: vi.fn().mockResolvedValue([]),
        resolveControlledBy: vi.fn().mockResolvedValue(null),
        quoteSubscription: quoteSubscription as never,
      },
    );
    expect(quoteSubscription).toHaveBeenCalledWith({
      source: { kind: 'stripe', id: 'subscription_1' }, billingMonth: '2026-07',
    }, { prisma });
    expect(statement.plan.monthly_subscription).toMatchObject({
      amount_minor: '2000', amount_role: 'per_seat_unit', charge_basis: 'per_seat',
      seat_policy: 'fixed', seat_timing: 'prorated',
    });
    expect(statement.commercial_lines.find((line) => line.kind === 'monthly_subscription')?.amount)
      .toMatchObject({ amount: '30', currency: 'GBP' });
    const open = await getCanonicalBillingStatement(
      { request, actorToken: 'signed-actor', credential, billingMonth: '2026-07' },
      { prisma: prisma as never, now: () => new Date('2026-07-15T00:00:00.000Z'),
        resolveSummary: vi.fn().mockResolvedValue(summary) as never,
        fetchMetering: vi.fn(async (params: { groupBy: 'service' | 'user' }) =>
          metering(params.groupBy)) as never,
        listDirectAccess: vi.fn().mockResolvedValue([]),
        resolveControlledBy: vi.fn().mockResolvedValue(null),
        quoteSubscription: quoteSubscription as never,
      },
    );
    expect(open.commercial_lines.some((line) => line.kind === 'monthly_subscription')).toBe(false);
    expect(quoteSubscription).toHaveBeenCalledTimes(1);
  });

  it('rates immutable raw metering centrally and emits a display-ready v1 model', async () => {
    const fetchMetering = vi.fn(async (params: { groupBy: 'service' | 'user' }) =>
      metering(params.groupBy),
    );
    const accessUpsert = vi.fn();
    const prisma = {
      billingTariff: {
        findUnique: vi.fn().mockResolvedValue({ name: 'Standard' }),
      },
      organisation: {
        findUnique: vi.fn().mockResolvedValue({ name: 'Acme', billingOrgResponsibility: null }),
      },
      billingService: {
        findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-01' }),
        findMany: vi.fn().mockResolvedValue([
          { identifier: 'deepwater', name: 'DeepWater' },
          { identifier: 'nessie', name: 'Nessie' },
          { identifier: 'deepsignal', name: 'DeepSignal' },
        ]),
      },
      billingTariffTermEvent: {
        findFirst: vi.fn().mockResolvedValue(effectiveTerm),
      },
      billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([]) },
      billingCommercialAdjustment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'adjustment_addon',billingAccountId:'projection-account',
            kind: BillingAdjustmentKind.ADD_ON,
            cadence: BillingAdjustmentCadence.MONTHLY,
            active: true,
            name: 'Provider cost markup adjustment',
            amountMinor: 1000n,
            currency: 'GBP',
          },
          {
            id: 'adjustment_credit',billingAccountId:'projection-account',
            kind: BillingAdjustmentKind.CREDIT,
            cadence: BillingAdjustmentCadence.ONE_TIME,
            active: true,
            name: 'Service credit',
            amountMinor: 500n,
            currency: 'GBP',
          },
        ]),
      },
      teamMember: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { user: { id: 'user_1', name: 'Ada', email: 'ada@example.com' } },
            { user: { id: 'user_2', name: 'Lin', email: 'lin@example.com' } },
          ]),
      },
      billingServiceAccess: {
        upsert: accessUpsert,
      },
    };

    const statement = await getCanonicalBillingStatement(
      { request, actorToken: 'signed-actor', credential, billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        now: () => now,
        resolveSummary: vi.fn().mockResolvedValue(summary) as never,
        fetchMetering: fetchMetering as never,
        listDirectAccess: vi.fn().mockResolvedValue([
          {
            serviceId: 'service_deepwater',
            product: 'deepwater',
            name: 'DeepWater',
            userIds: ['user_1'],
          },
          {
            serviceId: 'service_nessie',
            product: 'nessie',
            name: 'Nessie',
            userIds: ['user_1', 'user_2'],
          },
        ]),
      },
    );

    expect(accessUpsert).not.toHaveBeenCalled();
    expect(fetchMetering).toHaveBeenCalledTimes(2);
    expect(statement).toMatchObject({
      schema_version: 1,
      product: { identifier: 'deepwater', name: 'DeepWater' },
      period: { key: '2026-07', state: 'open' },
      plan: {
        display_name: 'Monthly subscription',
        monthly_subscription: {
          amount_minor: '2000',
          amount: '20',
          currency: 'GBP',
          display: '£20.00',
        },
      },
      subscription: {
        id: 'subscription_1',
        display_status: 'Active',
      },
      capabilities: {
        can_upgrade: false,
        can_open_portal: true,
        can_cancel: true,
      },
    });
    expect(statement.pinned_inputs.ledger_snapshots).toEqual([
      expect.objectContaining({ group_by: 'service', sha256: 'a'.repeat(64) }),
      expect.objectContaining({ group_by: 'user', sha256: 'b'.repeat(64) }),
    ]);
    expect(statement.usage).not.toHaveProperty('totals');
    expect(JSON.stringify(statement)).not.toMatch(/raw_units|usage_unit|provider_cost/i);
    expect(statement.usage.charge_totals).toEqual([
      {
        currency: 'USD',
        usage_charge: { amount: '3.6', currency: 'USD', display: '$3.60' },
      },
    ]);
    expect(statement.usage.user_totals).toEqual([
      expect.objectContaining({
        user_id: 'user_1',
        email: 'ada@example.com',
        charges: [
          expect.objectContaining({
            usage_charge: expect.objectContaining({ amount: '1.2' }),
          }),
        ],
      }),
      expect.objectContaining({
        user_id: 'user_2',
        email: 'lin@example.com',
        charges: [
          expect.objectContaining({
            usage_charge: expect.objectContaining({ amount: '1.2' }),
          }),
        ],
      }),
    ]);
    expect(statement.services).toEqual([
      expect.objectContaining({
        product: 'deepsignal',
        access: 'indirect',
        direct_user_count: 0,
      }),
      expect.objectContaining({
        product: 'deepwater',
        access: 'direct',
        direct_user_count: 1,
      }),
      expect.objectContaining({
        product: 'nessie',
        access: 'direct',
        direct_user_count: 2,
      }),
    ]);
    expect(statement.totals).toEqual([
      {
        currency: 'GBP',
        monthly: expect.objectContaining({ amount: '20' }),
        usage: expect.objectContaining({ amount: '0' }),
        add_ons: expect.objectContaining({ amount: '10' }),
        credits: expect.objectContaining({ amount: '-5' }),
        total_due: expect.objectContaining({ amount: '25', display: '£25.00' }),
      },
      {
        currency: 'USD',
        monthly: expect.objectContaining({ amount: '0' }),
        usage: expect.objectContaining({ amount: '3.6' }),
        add_ons: expect.objectContaining({ amount: '0' }),
        credits: expect.objectContaining({ amount: '0' }),
        total_due: expect.objectContaining({ amount: '3.6', display: '$3.60' }),
      },
    ]);
    expect(statement.actions.find((action) => action.id === 'cancel')).toMatchObject({
      enabled: true,
      request: {
        path: '/billing/v1/cancellation/preview',
        body: {
          product: 'deepwater',
          organisation_id: 'org_1',
          team_id: 'team_1',
          user_id: 'user_1',
        },
      },
    });

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingStatementV1JsonSchema);
    expect(validate(statement), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(statement)).not.toMatch(
      /markup|provider[_ ]cost|multiplier|billable_units|rated_charge|cost_totals/i,
    );
    expect(statement.usage.lines[0]?.customer_charge?.amount).toBe('2.4');
  });

  it('offers no action at all while the organisation pays and the caller cannot manage it', async () => {
    const prisma = {
      organisation: {
        findUnique: vi.fn().mockResolvedValue({ name: 'Acme', billingOrgResponsibility: null }),
      },
      billingTariff: { findUnique: vi.fn().mockResolvedValue({ name: 'Standard' }) },
      billingService: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-01' }),
      },
      billingTariffTermEvent: { findFirst: vi.fn().mockResolvedValue(effectiveTerm) },
      billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([]) },
      billingCommercialAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
      teamMember: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const controlledBy = {
      scope: 'organisation' as const,
      organisation_id: 'org_1',
      organisation_name: 'Acme',
      message: 'Billing for this team is managed for the whole of Acme.',
      can_manage: false,
      manage_action_id: null,
    };

    const statement = await getCanonicalBillingStatement(
      { request, actorToken: 'signed-actor', credential, billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        now: () => now,
        resolveSummary: vi.fn().mockResolvedValue(summary) as never,
        fetchMetering: vi.fn(async (params: { groupBy: 'service' | 'user' }) =>
          metering(params.groupBy),
        ) as never,
        listDirectAccess: vi.fn().mockResolvedValue([]),
        resolveControlledBy: vi.fn().mockResolvedValue(controlledBy),
      },
    );

    // A 1.2.0 consumer knows nothing about `controlled_by`; an empty action
    // list is what makes it render read-only instead of buttons that 403.
    expect(statement.actions).toEqual([]);
    expect(statement.capabilities).toEqual({
      can_upgrade: false,
      can_open_portal: false,
      can_cancel: false,
    });
    expect(statement.controlled_by).toEqual(controlledBy);

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingStatementV1JsonSchema);
    expect(validate(statement), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a future statement period before touching external state', async () => {
    const resolveSummary = vi.fn();
    await expect(
      getCanonicalBillingStatement(
        { request, actorToken: 'signed-actor', credential, billingMonth: '2026-08' },
        { now: () => now, resolveSummary },
      ),
    ).rejects.toThrow('BILLING_MONTH_FUTURE');
    expect(resolveSummary).not.toHaveBeenCalled();
  });
});
