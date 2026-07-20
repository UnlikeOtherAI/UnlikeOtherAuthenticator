import {
  BillingAdjustmentCadence,
  BillingAdjustmentKind,
  BillingAppKeyPurpose,
} from '@prisma/client';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';

import { billingStatementV1JsonSchema } from '../../src/contracts/billing-statement-v1.js';
import type { NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';
import { getCanonicalBillingStatement } from '../../src/services/billing-statement.service.js';

const now = new Date('2026-07-20T12:00:00.000Z');
const credential = {
  id: 'app_key_deepwater_lifecycle',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/customer-statement',
  actorKeyId: 'deepwater_actor_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};
const summary = {
  product: { id: 'service_deepwater', identifier: 'deepwater' },
  subject: {
    user_id: 'user_1',
    organisation_id: 'org_1',
    team_id: 'team_1',
  },
  tariff: {
    id: 'tariff_standard_v4',
    key: 'standard',
    version: 4,
    mode: 'standard' as const,
    collection_mode: 'stripe' as const,
    markup_bps: 2_000,
    markup_percent: '20.00',
    usage_price_multiplier_bps: 12_000,
    monthly_subscription: { amount_minor: '2000', currency: 'GBP' },
    usage_billing_enabled: true,
    payment_collection_enabled: true,
    raw_usage_preserved: true as const,
  },
  assignment: { scope: 'team' as const, id: 'assignment_1' },
  stripe_collection_enabled: true,
  stripe_mode: 'test' as const,
  can_manage: true,
  subscription: {
    id: 'subscription_1',
    status: 'active',
    scope: 'team',
    scope_key: 'org_1:team_1',
    tariff_id: 'tariff_standard_v4',
    cancel_at_period_end: false,
    current_period_start: '2026-07-01T00:00:00.000Z',
    current_period_end: '2026-08-01T00:00:00.000Z',
    billing_phase: 'calendar_month',
    created_at: '2026-07-01T00:00:00.000Z',
    synced_at: now.toISOString(),
  },
};

function metering(groupBy: 'service' | 'user'): NormalizedMeteringUsage {
  const shared = {
    schemaVersion: 1 as const,
    product: 'deepwater',
    groupBy,
    scope: {
      organizationId: 'org_1',
      teamId: 'team_1',
      userId: null,
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    calls: '2',
    snapshot: {
      cursor:
        groupBy === 'service'
          ? 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV'
          : 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV',
      id:
        groupBy === 'service'
          ? 'mus_0123456789ABCDEFGHIJKLMNOPQRSTUV'
          : 'mus_1123456789ABCDEFGHIJKLMNOPQRSTUV',
      capturedAt: '2026-07-20T11:59:00.000Z',
      immutable: true as const,
      sha256: groupBy === 'service' ? 'a'.repeat(64) : 'b'.repeat(64),
    },
  };
  if (groupBy === 'service') {
    return {
      ...shared,
      lines: [
        {
          serviceId: 'openai',
          usageUnit: 'tokens',
          calls: '2',
          inputUnits: '100',
          cachedInputUnits: '0',
          outputUnits: '50',
          estimatedProviderCost: null,
          actualProviderCost: '2',
          currency: 'USD',
          costProvenance: 'provider_invoice',
          billingProduct: 'deepwater',
          callerProduct: 'nessie',
          originProduct: 'deepsignal',
          userId: null,
        },
        {
          serviceId: 'serp',
          usageUnit: 'requests',
          calls: '1',
          inputUnits: '10',
          cachedInputUnits: '0',
          outputUnits: '0',
          estimatedProviderCost: '1',
          actualProviderCost: null,
          currency: 'USD',
          costProvenance: 'provider_pricebook',
          billingProduct: 'deepwater',
          callerProduct: 'deepwater',
          originProduct: 'nessie',
          userId: null,
        },
      ],
    };
  }
  return {
    ...shared,
    lines: [
      {
        serviceId: 'openai',
        usageUnit: 'tokens',
        calls: '1',
        inputUnits: '40',
        cachedInputUnits: '0',
        outputUnits: '20',
        estimatedProviderCost: '1',
        actualProviderCost: null,
        currency: 'USD',
        costProvenance: 'provider_pricebook',
        billingProduct: 'deepwater',
        callerProduct: 'nessie',
        originProduct: 'nessie',
        userId: 'user_1',
      },
      {
        serviceId: 'openai',
        usageUnit: 'tokens',
        calls: '1',
        inputUnits: '60',
        cachedInputUnits: '0',
        outputUnits: '30',
        estimatedProviderCost: null,
        actualProviderCost: '1',
        currency: 'USD',
        costProvenance: 'provider_invoice',
        billingProduct: 'deepwater',
        callerProduct: 'nessie',
        originProduct: 'nessie',
        userId: 'user_2',
      },
    ],
  };
}

describe('canonical UOA billing statement', () => {
  it('rates immutable raw metering centrally and emits a display-ready v1 model', async () => {
    const confirmAccess = vi.fn().mockResolvedValue(undefined);
    const fetchMetering = vi.fn(async (params: { groupBy: 'service' | 'user' }) =>
      metering(params.groupBy),
    );
    const prisma = {
      billingTariff: {
        findUnique: vi.fn().mockResolvedValue({ name: 'Standard' }),
      },
      billingCommercialAdjustment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'adjustment_addon',
            kind: BillingAdjustmentKind.ADD_ON,
            cadence: BillingAdjustmentCadence.MONTHLY,
            active: true,
            name: 'Priority support',
            amountMinor: 1000n,
            currency: 'GBP',
          },
          {
            id: 'adjustment_credit',
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
    };

    const statement = await getCanonicalBillingStatement(
      { request, actorToken: 'signed-actor', credential, billingMonth: '2026-07' },
      {
        prisma: prisma as never,
        now: () => now,
        resolveSummary: vi.fn().mockResolvedValue(summary) as never,
        fetchMetering: fetchMetering as never,
        confirmAccess,
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

    expect(confirmAccess).toHaveBeenCalledWith(
      {
        serviceId: 'service_deepwater',
        appKeyId: 'app_key_deepwater_lifecycle',
        organisationId: 'org_1',
        teamId: 'team_1',
        userId: 'user_1',
      },
      { prisma },
    );
    expect(fetchMetering).toHaveBeenCalledTimes(2);
    expect(statement).toMatchObject({
      schema_version: 1,
      product: { identifier: 'deepwater', name: 'DeepWater' },
      period: { key: '2026-07', state: 'open' },
      plan: {
        display_name: 'Standard · v4',
        markup_bps: 2_000,
        markup_display: '20.00%',
        monthly_subscription: {
          amount_minor: '2000',
          amount: '20',
          currency: 'GBP',
          display: '£20',
        },
      },
      subscription: {
        id: 'subscription_1',
        display_status: 'active',
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
    expect(statement.usage.totals).toEqual([
      {
        usage_unit: 'requests',
        raw_units: '10',
        billable_units: '12',
        display: '12 billable requests (10 raw)',
      },
      {
        usage_unit: 'tokens',
        raw_units: '150',
        billable_units: '180',
        display: '180 billable tokens (150 raw)',
      },
    ]);
    expect(statement.usage.cost_totals).toEqual([
      {
        currency: 'USD',
        provider_cost: { amount: '3', currency: 'USD', display: '$3' },
        markup: { amount: '0.6', currency: 'USD', display: '$0.6' },
        usage_charge: { amount: '3.6', currency: 'USD', display: '$3.6' },
      },
    ]);
    expect(statement.usage.user_totals).toEqual([
      expect.objectContaining({
        user_id: 'user_1',
        email: 'ada@example.com',
        costs: [
          expect.objectContaining({
            usage_charge: expect.objectContaining({ amount: '1.2' }),
          }),
        ],
      }),
      expect.objectContaining({
        user_id: 'user_2',
        email: 'lin@example.com',
        costs: [
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
        total_due: expect.objectContaining({ amount: '25', display: '£25' }),
      },
      {
        currency: 'USD',
        monthly: expect.objectContaining({ amount: '0' }),
        usage: expect.objectContaining({ amount: '3.6' }),
        add_ons: expect.objectContaining({ amount: '0' }),
        credits: expect.objectContaining({ amount: '0' }),
        total_due: expect.objectContaining({ amount: '3.6', display: '$3.6' }),
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
