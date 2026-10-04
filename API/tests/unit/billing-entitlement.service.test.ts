import {
  BillingAssignmentScope,
  BillingAppKeyPurpose,
  BillingCollectionMode,
  BillingMonthlyChargeBasis,
  BillingSeatChargeTiming,
  BillingSeatPolicy,
  BillingUsagePaymentMode,
  BillingTariffMode,
  BillingTariffSource,
  MembershipStatus,
  type PrismaClient,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  customerBillingTariff, getEffectiveTariffSnapshot,
} from '../../src/services/billing-entitlement.service.js';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';

const credential: VerifiedBillingAppKey = {
  id: 'key_1',
  purpose: BillingAppKeyPurpose.ENTITLEMENT,
  actorIssuer: 'https://ledger.unlikeotherai.com',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'ledger-key',
  actorPublicJwk: {},
  checkoutReturnOrigins: [],
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
};
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'usr_1',
};
const defaultTariff = {
  id: 'tariff_default',
  serviceId: 'service_1',
  key: 'standard',
  version: 1,
  name: 'Standard',
  mode: BillingTariffMode.STANDARD,
  collectionMode: BillingCollectionMode.STRIPE,
  markupBps: 2_000,
  monthlyAmountMinor: 0n,
  monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT,
  seatPolicy: null,
  seatChargeTiming: null,
  usagePaymentMode: BillingUsagePaymentMode.PAY_AS_YOU_GO,
  currency: 'USD',
  isDefault: true,
  createdByUserId: null,
  createdByEmail: null,
  createdAt: new Date(),
};

function fakePrisma(params: {
  teamAssignment?: unknown;
  orgAssignment?: unknown;
  fallback?: typeof defaultTariff | null;
  active?: boolean;
  tokenVersion?: number;
}): PrismaClient {
  const active = params.active ?? true;
  const prisma = {
    billingService: {
      findFirst: vi.fn().mockResolvedValue(active ? { id: 'service_1' } : null),
      findUnique: vi.fn().mockResolvedValue({ tariffHistoryFromMonth: '2026-01' }),
    },
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(active ? { id: 'usr_1', tokenVersion: params.tokenVersion ?? 0 } : null),
    },
    orgMember: {
      findUnique: vi.fn().mockResolvedValue(active ? { status: MembershipStatus.ACTIVE } : null),
    },
    team: {
      findFirst: vi.fn().mockResolvedValue(active ? { id: 'team_1' } : null),
    },
    billingTariffAssignment: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(params.teamAssignment ?? null)
        .mockResolvedValueOnce(params.orgAssignment ?? null),
    },
    billingTariff: {
      findFirst: vi.fn().mockResolvedValue(params.fallback ?? defaultTariff),
    },
    billingTariffTermEvent: {
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { source: BillingTariffSource } }) => {
        const assignment = where.source === BillingTariffSource.TEAM
          ? params.teamAssignment
          : where.source === BillingTariffSource.ORGANISATION
            ? params.orgAssignment : null;
        if (assignment) {
          const row = assignment as { id: string; tariff: typeof defaultTariff };
          return { tariffId: row.tariff.id, tariff: row.tariff, assignmentId: row.id };
        }
        if (where.source === BillingTariffSource.SERVICE_DEFAULT) {
          const tariff = params.fallback ?? defaultTariff;
          return tariff ? { tariffId: tariff.id, tariff, assignmentId: null } : null;
        }
        return null;
      }),
    },
    billingOrganisationContractVersion: { findMany: vi.fn().mockResolvedValue([]) },
    billingServiceAccess: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma)),
  };
  return prisma as unknown as PrismaClient;
}

const verifyActor = vi.fn().mockResolvedValue({ tv: 0 });
const signSnapshot = vi.fn().mockResolvedValue('signed-snapshot');

describe('effective billing tariff resolution', () => {
  beforeEach(() => {
    verifyActor.mockClear();
    signSnapshot.mockClear();
  });

  it('prefers a team assignment without exposing private rating terms', async () => {
    const teamTariff = {
      ...defaultTariff,
      id: 'tariff_team',
      key: 'custom',
      version: 3,
      mode: BillingTariffMode.CUSTOM,
      collectionMode: BillingCollectionMode.NONE,
      markupBps: 4_000,
      monthlyAmountMinor: 2_000n,
      monthlyChargeBasis: BillingMonthlyChargeBasis.PER_SEAT,
      seatPolicy: BillingSeatPolicy.FIXED,
      seatChargeTiming: BillingSeatChargeTiming.PRORATED,
      usagePaymentMode: BillingUsagePaymentMode.PREPAID,
    };
    const prisma = fakePrisma({
      teamAssignment: {
        id: 'assignment_team',
        scope: BillingAssignmentScope.TEAM,
        tariff: teamTariff,
      },
      orgAssignment: {
        id: 'assignment_org',
        scope: BillingAssignmentScope.ORGANISATION,
        tariff: defaultTariff,
      },
    });
    const result = await getEffectiveTariffSnapshot(
      {
        request,
        actorToken: 'actor',
        credential,
      },
      {
        prisma,
        now: () => 1_800_000_000,
        verifyActor,
        signSnapshot,
      },
    );

    expect(result.snapshot).toBe('signed-snapshot');
    expect(result.payload).toMatchObject({
      schema_version: 1,
      product: { identifier: 'deepwater' },
      authorized_party: { app_key_id: 'key_1' },
      tariff: {
        id: 'tariff_team',
        collection_mode: 'none',
        monthly_subscription: { amount_minor: '2000', currency: 'USD',
          charge_basis: 'per_seat', seat_policy: 'fixed', seat_timing: 'prorated',
          amount_role: 'per_seat_unit' },
        usage_payment_mode: 'prepaid',
        usage_billing_enabled: true,
        payment_collection_enabled: false,
        raw_usage_preserved: true,
      },
      assignment: { scope: 'team', id: 'assignment_team' },
    });
    expect(result.payload).not.toHaveProperty('tokens');
    expect(result.payload).not.toHaveProperty('usage');
    expect(JSON.stringify(result.payload)).not.toMatch(/markup|multiplier|at_cost|provider_cost/i);
    expect(customerBillingTariff(result.payload.tariff)).toMatchObject({
      monthly_subscription: { amount_minor: '2000', amount_role: 'per_seat_unit' },
      usage_payment_mode: 'prepaid',
    });
    expect(customerBillingTariff(result.payload.tariff)).not.toHaveProperty('id');
    expect(customerBillingTariff(result.payload.tariff)).not.toHaveProperty('mode');
    expect(prisma.billingServiceAccess.upsert).not.toHaveBeenCalled();
  });

  it('falls back from organisation assignment to service default', async () => {
    const orgResult = await getEffectiveTariffSnapshot(
      { request, actorToken: 'actor', credential },
      {
        prisma: fakePrisma({
          orgAssignment: {
            id: 'assignment_org',
            scope: BillingAssignmentScope.ORGANISATION,
            tariff: defaultTariff,
          },
        }),
        verifyActor,
        signSnapshot,
      },
    );
    expect(orgResult.payload.assignment.scope).toBe('organisation');

    const defaultResult = await getEffectiveTariffSnapshot(
      { request, actorToken: 'actor', credential },
      {
        prisma: fakePrisma({ fallback: defaultTariff }),
        verifyActor,
        signSnapshot,
      },
    );
    expect(defaultResult.payload.assignment).toEqual({
      scope: 'service_default',
      id: null,
    });
  });

  it('fails closed when the user no longer has active team membership', async () => {
    await expect(
      getEffectiveTariffSnapshot(
        { request, actorToken: 'actor', credential },
        {
          prisma: fakePrisma({ active: false }),
          verifyActor,
          signSnapshot,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'BILLING_SUBJECT_NOT_ENTITLED',
    });
    expect(signSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed when the billing actor credential epoch is stale', async () => {
    await expect(
      getEffectiveTariffSnapshot(
        { request, actorToken: 'actor', credential },
        {
          prisma: fakePrisma({ tokenVersion: 1 }),
          verifyActor,
          signSnapshot,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'BILLING_SUBJECT_NOT_ENTITLED',
    });
  });

  it('rejects a product identifier that does not match the individual app key', async () => {
    await expect(
      getEffectiveTariffSnapshot(
        {
          request: { ...request, product: 'deeptest' },
          actorToken: 'actor',
          credential,
        },
        {
          prisma: fakePrisma({}),
          verifyActor,
          signSnapshot,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'BILLING_PRODUCT_MISMATCH',
    });
    expect(verifyActor).not.toHaveBeenCalled();
    expect(signSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: BillingTariffMode.FREE,
      collectionMode: BillingCollectionMode.NONE,
      usageBillingEnabled: false,
      paymentCollectionEnabled: false,
    },
    {
      mode: BillingTariffMode.AT_COST,
      collectionMode: BillingCollectionMode.NONE,
      usageBillingEnabled: true,
      paymentCollectionEnabled: false,
    },
  ])(
    'emits the exact $mode price semantics without changing raw usage',
    async ({
      mode,
      collectionMode,
      usageBillingEnabled,
      paymentCollectionEnabled,
    }) => {
      const result = await getEffectiveTariffSnapshot(
        { request, actorToken: 'actor', credential },
        {
          prisma: fakePrisma({
            fallback: {
              ...defaultTariff,
              id: `tariff_${mode.toLowerCase()}`,
              mode,
              collectionMode,
              markupBps: 0,
            },
          }),
          verifyActor,
          signSnapshot,
        },
      );

      expect(result.payload.tariff).toMatchObject({
        usage_billing_enabled: usageBillingEnabled,
        payment_collection_enabled: paymentCollectionEnabled,
        raw_usage_preserved: true,
      });
    },
  );
});
