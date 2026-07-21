import { BillingAppKeyPurpose } from '@prisma/client';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';

import { billingStatementV2JsonSchema } from '../../src/contracts/billing-statement-v1.js';
import type {
  NormalizedMeteringPortfolio,
  RawMeteringLine,
} from '../../src/services/billing-metering.types.js';
import { getCanonicalBillingStatementV2 } from '../../src/services/billing-statement.service.js';

const now = new Date('2026-07-20T12:00:00.000Z');
const credential = {
  id: 'app_key_deepwater_lifecycle',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v2/customer-statement',
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

function line(overrides: Partial<RawMeteringLine> = {}): RawMeteringLine {
  const result: RawMeteringLine = {
    serviceId: 'openai',
    usageUnit: 'tokens',
    calls: '1',
    inputUnits: '0',
    cachedInputUnits: '0',
    outputUnits: '0',
    estimatedProviderCost: null,
    actualProviderCost: null,
    selectedProviderCost: null,
    currency: null,
    costProvenance: null,
    billingProduct: 'deepwater',
    callerProduct: 'deepwater',
    originProduct: 'deepwater',
    userId: null,
    ...overrides,
  };
  if (overrides.selectedProviderCost === undefined) {
    result.selectedProviderCost = result.actualProviderCost ?? result.estimatedProviderCost;
  }
  return result;
}

function portfolio(
  groupBy: 'service' | 'user',
  lines: RawMeteringLine[],
): NormalizedMeteringPortfolio {
  const suffix = groupBy === 'service' ? '0' : '1';
  return {
    schemaVersion: 1,
    contract: 'metering-portfolio-v1',
    perspectiveProduct: 'deepwater',
    groupBy,
    scope: {
      organizationId: 'org_1',
      teamId: 'team_1',
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    calls: lines.reduce((total, item) => total + Number(item.calls), 0).toString(),
    lines,
    snapshot: {
      cursor: `mup_${suffix}123456789ABCDEFGHIJKLMNOPQRSTUV`,
      id: `mup_${suffix}123456789ABCDEFGHIJKLMNOPQRSTUV`,
      capturedAt: groupBy === 'service' ? '2026-07-20T11:59:00.000Z' : '2026-07-20T11:59:01.000Z',
      immutable: true,
      sha256: (groupBy === 'service' ? 'c' : 'd').repeat(64),
    },
  };
}

function prisma() {
  return {
    billingTariff: {
      findUnique: vi.fn().mockResolvedValue({ name: 'Standard' }),
    },
    billingService: {
      findMany: vi.fn().mockResolvedValue([
        { identifier: 'deepwater', name: 'DeepWater' },
        { identifier: 'nessie', name: 'Nessie' },
        { identifier: 'deeptest', name: 'DeepTest' },
      ]),
    },
    billingCommercialAdjustment: {
      findMany: vi.fn().mockResolvedValue([]),
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
}

function dependencies(
  fetchPortfolio: (params: {
    groupBy: 'service' | 'user';
    product: string;
  }) => Promise<NormalizedMeteringPortfolio>,
) {
  const database = prisma();
  return {
    database,
    values: {
      prisma: database as never,
      now: () => now,
      resolveSummary: vi.fn().mockResolvedValue(summary) as never,
      fetchPortfolio,
      confirmAccess: vi.fn().mockResolvedValue(undefined),
      listDirectAccess: vi.fn().mockResolvedValue([
        {
          serviceId: 'service_deepwater',
          product: 'deepwater',
          name: 'DeepWater',
          userIds: ['user_1'],
        },
      ]),
    },
  };
}

describe('canonical UOA BillingStatementV2', () => {
  it('rates only the statement product and emits a self-consistent user-snapshot portfolio', async () => {
    const userLines = [
      line({
        calls: '5',
        inputUnits: '400',
        outputUnits: '160',
        estimatedProviderCost: '7',
        actualProviderCost: '4.6',
        selectedProviderCost: '5.6',
        currency: 'USD',
        userId: 'user_1',
      }),
      line({
        inputUnits: '40',
        estimatedProviderCost: '0.4',
        currency: 'USD',
        originProduct: 'nessie',
        userId: 'user_1',
      }),
      line({
        calls: '4',
        inputUnits: '300',
        outputUnits: '100',
        estimatedProviderCost: '4',
        currency: 'USD',
        originProduct: 'nessie',
        userId: 'user_2',
      }),
      line({
        calls: '2',
        inputUnits: '150',
        outputUnits: '50',
        estimatedProviderCost: '2',
        currency: 'USD',
        billingProduct: 'nessie',
        callerProduct: 'nessie',
        originProduct: 'nessie',
        userId: 'user_1',
      }),
      line({
        serviceId: 'deeptest',
        usageUnit: 'test_runs',
        inputUnits: '1',
        billingProduct: 'deeptest',
        callerProduct: 'deeptest',
        originProduct: 'deeptest',
        userId: 'user_2',
      }),
    ];
    const fetchPortfolio = vi.fn(async (params: { groupBy: 'service' | 'user'; product: string }) =>
      portfolio(params.groupBy, userLines),
    );
    const deps = dependencies(fetchPortfolio);
    const statement = await getCanonicalBillingStatementV2(
      { request, actorToken: 'signed-actor', credential, billingMonth: '2026-07' },
      deps.values,
    );

    expect(fetchPortfolio).toHaveBeenCalledTimes(1);
    expect(fetchPortfolio).toHaveBeenCalledWith({
      product: 'deepwater',
      organisationId: 'org_1',
      teamId: 'team_1',
      billingMonth: '2026-07',
      groupBy: 'user',
    });
    expect(statement.usage.cost_totals).toEqual([
      expect.objectContaining({
        provider_cost: expect.objectContaining({ amount: '10' }),
        markup: expect.objectContaining({ amount: '2' }),
        usage_charge: expect.objectContaining({ amount: '12' }),
      }),
    ]);
    const deepWater = statement.connected_service_usage.services.find(
      (service) => service.billing_product === 'deepwater',
    );
    expect(deepWater).toMatchObject({
      access: 'direct',
      totals: { usage: [{ usage_unit: 'tokens', raw_units: '1000' }] },
      users: [
        expect.objectContaining({
          user_id: 'user_1',
          usage: [
            expect.objectContaining({
              raw_units: '600',
              share: expect.objectContaining({ basis_points: 6000 }),
            }),
          ],
        }),
        expect.objectContaining({
          user_id: 'user_2',
          usage: [
            expect.objectContaining({
              raw_units: '400',
              share: expect.objectContaining({ basis_points: 4000 }),
            }),
          ],
        }),
      ],
    });
    expect(deepWater?.origins.find((origin) => origin.product === 'nessie')).toMatchObject({
      usage: [
        expect.objectContaining({
          raw_units: '440',
          share: expect.objectContaining({ basis_points: 4400, percent: '44.00' }),
        }),
      ],
    });
    expect(
      statement.connected_service_usage.services.find(
        (service) => service.billing_product === 'deeptest',
      ),
    ).toMatchObject({
      access: 'indirect',
      totals: { usage: [{ usage_unit: 'test_runs', raw_units: '1' }] },
    });
    expect(statement.commercial_lines.every((item) => item.product === 'deepwater')).toBe(true);
    expect(deps.database.teamMember.findMany).toHaveBeenCalledWith({
      where: {
        teamId: 'team_1',
        status: 'ACTIVE',
        user: {
          orgMembers: {
            some: {
              orgId: 'org_1',
              status: 'ACTIVE',
            },
          },
        },
      },
      select: { user: { select: { id: true, name: true, email: true } } },
    });

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(billingStatementV2JsonSchema);
    expect(validate(statement), JSON.stringify(validate.errors)).toBe(true);
  });

  it('preserves unknown provenance and canonicalizes the statement product once', async () => {
    const unknown = line({
      inputUnits: '100',
      estimatedProviderCost: '1',
      currency: 'USD',
      callerProduct: null,
      originProduct: null,
      userId: 'user_1',
    });
    const fetchPortfolio = vi.fn(async (params: { groupBy: 'service' | 'user'; product: string }) =>
      portfolio(params.groupBy, [
        { ...unknown, userId: params.groupBy === 'user' ? 'user_1' : null },
      ]),
    );
    const deps = dependencies(fetchPortfolio);
    const statement = await getCanonicalBillingStatementV2(
      {
        request: { ...request, product: 'DEEPWATER' },
        actorToken: 'signed-actor',
        credential,
        billingMonth: '2026-07',
      },
      deps.values,
    );

    expect(fetchPortfolio).toHaveBeenCalledTimes(1);
    expect(fetchPortfolio).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'deepwater', groupBy: 'user' }),
    );
    expect(statement.usage.lines[0]?.attribution).toMatchObject({
      caller_product: 'unattributed',
      origin_product: 'unattributed',
    });
    expect(
      statement.connected_service_usage.services[0]?.origins.find(
        (origin) => origin.product === null,
      ),
    ).toMatchObject({
      display_name: 'Unattributed origin',
      usage: [
        expect.objectContaining({
          share: expect.objectContaining({ basis_points: 10000 }),
        }),
      ],
    });
    expect(statement.actions.find((action) => action.id === 'cancel')).toMatchObject({
      request: { body: { product: 'deepwater' } },
    });
  });
});
