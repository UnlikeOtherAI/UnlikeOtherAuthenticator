import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingBrowserReserveRequestV1 } from '@unlikeotherai/billing-statement-protocol';
import { createTestDb } from '../helpers/test-db.js';
import { browserFinancialFixture } from '../helpers/browser-financial-fixture.js';
import { smsIds } from '../helpers/sms-financial-fixture.js';
import {
  reserveBrowser,
  readBrowserTariff,
  type BrowserBillingDependencies,
} from '../../src/services/billing-browser-reservation.service.js';
import {
  claimBrowser,
  releaseBrowserReservation,
} from '../../src/services/billing-browser-dispatch.service.js';
import { settleBrowser } from '../../src/services/billing-browser-receipt.service.js';
import {
  listPaidUsageExceptions,
  writeOffPaidUsageException,
} from '../../src/services/billing-paid-usage-exception.service.js';
import { billingReservedMicrocredits } from '../../src/services/billing-credit-holds.service.js';

let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let fixture: Awaited<ReturnType<typeof browserFinancialFixture>>;
const deps = (): BrowserBillingDependencies => ({ prisma, stripe: fixture.stripe });
const read = (dispatch_id: string) => ({ product: 'nessie', dispatch_id });
const request = (extra: Partial<BillingBrowserReserveRequestV1> = {}): BillingBrowserReserveRequestV1 => ({
  ...fixture.subject,
  dispatch_id: randomUUID(),
  project_id: fixture.project,
  max_duration_seconds: 60,
  budget_context: null,
  ...extra,
});
async function reserve(body = request(), dependencies = deps()) {
  return reserveBrowser(
    {
      request: body,
      credential: fixture.credential,
      actorToken: await fixture.actor('/billing/v1/browser/reservations'),
    },
    dependencies,
  );
}
async function claim(dispatch: string) {
  return claimBrowser({ request: read(dispatch), credential: fixture.credential }, deps());
}
async function release(dispatch: string) {
  return releaseBrowserReservation(
    { request: { ...read(dispatch), proof: 'no_provider_dispatch' }, credential: fixture.credential },
    deps(),
  );
}
async function receipt(dispatch: string, milliseconds = 1000, proxyBytes = 0) {
  const row = await prisma.billingBrowserReservation.findUniqueOrThrow({ where: { dispatchId: dispatch } });
  const start = row.dispatchClaimedAt!;
  const end = new Date(start.getTime() + milliseconds);
  return {
    request: {
      ...read(dispatch),
      project_id: row.projectId,
      session_id: randomUUID(),
      status: 'COMPLETED' as const,
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      proxy_bytes: proxyBytes,
    },
    dependencies: { ...deps(), now: () => new Date(end.getTime() + 1000) },
  };
}

describe.skipIf(!process.env.DATABASE_URL)('central browser prepaid billing', () => {
  beforeAll(async () => {
    const db = (await createTestDb())!;
    prisma = db.prisma;
    cleanup = db.cleanup;
    fixture = await browserFinancialFixture(prisma);
  });
  afterAll(async () => {
    await cleanup?.();
    vi.unstubAllEnvs();
  });

  it('advertises the exact provider rate plus ten percent and the minimum minute', async () => {
    const result = await readBrowserTariff(
      {
        request: { ...fixture.subject, project_id: fixture.project },
        credential: fixture.credential,
        actorToken: await fixture.actor('/billing/v1/browser/tariff'),
      },
      deps(),
    );
    expect(result).toMatchObject({
      markup_bps: 1000,
      minimum_seconds: 60,
      rounding_seconds: 60,
      provider_price_per_hour: '0.12',
      customer_price_per_minute: '0.002200000000000000',
    });
  });
  it('reserves before dispatch, grants one claim, and charges a minimum minute exactly once', async () => {
    const body = request();
    const first = await reserve(body);
    expect((await reserve(body)).reservation_id).toBe(first.reservation_id);
    expect(first.can_dispatch).toBe(false);
    expect(await prisma.$queryRaw(Prisma.sql`
      SELECT code FROM billing_organisation_mode_blockers(${fixture.subject.organisation_id})
    `)).toContainEqual({ code: 'browser_reservation' });
    expect((await claim(body.dispatch_id)).can_dispatch).toBe(true);
    expect((await claim(body.dispatch_id)).can_dispatch).toBe(false);
    const value = await receipt(body.dispatch_id);
    const settled = await settleBrowser(
      { request: value.request, credential: fixture.credential },
      value.dependencies,
    );
    expect(settled).toMatchObject({ state: 'settled', consumed_credits: '2.200000' });
    expect(
      await settleBrowser({ request: value.request, credential: fixture.credential }, value.dependencies),
    ).toEqual(settled);
    const entries = await prisma.billingCreditEntry.findMany({
      where: { browserReservationId: first.reservation_id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      attributedUserId: smsIds.user,
      amountMicrocredits: 2200000n,
      kind: 'BROWSER_PREPAID_USAGE',
    });
    await expect(
      settleBrowser(
        { request: { ...value.request, proxy_bytes: 1 }, credential: fixture.credential },
        value.dependencies,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('fences cancellation before a delayed reserve, and safely releases a claimed but uncreated session', async () => {
    const cancelled = request();
    await release(cancelled.dispatch_id);
    await expect(reserve(cancelled)).rejects.toMatchObject({ statusCode: 409 });
    const body = request();
    await reserve(body);
    await claim(body.dispatch_id);
    await release(body.dispatch_id);
    expect((await claim(body.dispatch_id)).can_dispatch).toBe(false);
    expect(
      (await prisma.billingBrowserReservation.findUniqueOrThrow({ where: { dispatchId: body.dispatch_id } }))
        .state,
    ).toBe('released');
    expect(await release(body.dispatch_id)).toEqual({ dispatch_id: body.dispatch_id, released: true });
  });
  it('records a definite provider rejection, without accepting an ambiguous server failure as proof', async () => {
    const body = request();
    await reserve(body);
    await claim(body.dispatch_id);
    await expect(
      releaseBrowserReservation(
        {
          credential: fixture.credential,
          request: {
            ...read(body.dispatch_id),
            proof: 'provider_rejected',
            provider_http_status: 503 as 429,
          },
        },
        deps(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await releaseBrowserReservation(
      {
        credential: fixture.credential,
        request: {
          ...read(body.dispatch_id),
          proof: 'provider_rejected',
          provider_http_status: 429,
        },
      },
      deps(),
    );
    expect(
      await prisma.billingBrowserCancellation.findUnique({ where: { dispatchId: body.dispatch_id } }),
    ).toMatchObject({ proof: 'provider_rejected', providerHttpStatus: 429 });
  });
  it('refuses changed payers, projects, reservation bounds and unclaimed receipts', async () => {
    const body = request();
    await reserve(body);
    await expect(reserve({ ...body, max_duration_seconds: 120 })).rejects.toMatchObject({ statusCode: 409 });
    await expect(reserve({ ...body, user_id: 'someone-else' })).rejects.toBeDefined();
    await expect(reserve(request({ max_duration_seconds: 1801 }))).rejects.toMatchObject({ statusCode: 400 });
    const unclaimed = {
      ...read(body.dispatch_id),
      project_id: fixture.project,
      session_id: randomUUID(),
      status: 'COMPLETED' as const,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      proxy_bytes: 0,
    };
    await expect(
      settleBrowser({ request: unclaimed, credential: fixture.credential }, deps()),
    ).rejects.toMatchObject({ statusCode: 409 });
    await claim(body.dispatch_id);
    const value = await receipt(body.dispatch_id);
    await expect(
      settleBrowser(
        { request: { ...value.request, project_id: randomUUID() }, credential: fixture.credential },
        value.dependencies,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await release(body.dispatch_id);
  });
  it('retains ambiguous charges and their original evidence for reconciliation', async () => {
    const body = request();
    const reserved = await reserve(body);
    await claim(body.dispatch_id);
    const value = await receipt(body.dispatch_id, 121000);
    expect(
      (await settleBrowser({ request: value.request, credential: fixture.credential }, value.dependencies))
        .state,
    ).toBe('reconciliation');
    expect(await prisma.$queryRaw(Prisma.sql`
      SELECT code FROM billing_organisation_mode_blockers(${fixture.subject.organisation_id})
    `)).toContainEqual({ code: 'browser_reservation' });
    await expect(release(body.dispatch_id)).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await prisma.billingCreditEntry.count({ where: { browserReservationId: reserved.reservation_id } }),
    ).toBe(0);
    await expect(
      settleBrowser(
        { request: { ...value.request, ended_at: value.request.started_at }, credential: fixture.credential },
        value.dependencies,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const row = await prisma.billingBrowserReservation.findUniqueOrThrow({
      where: { id: reserved.reservation_id },
    });
    expect(row.reservedMicrocredits).toBe(4400000n);
  });
  it.each([0, 4096])(
    'resolves an unusual receipt once through the operator waiver flow (proxy bytes %s)',
    async (proxyBytes) => {
      const body = request();
      const reserved = await reserve(body);
      await claim(body.dispatch_id);
      const value = await receipt(body.dispatch_id, proxyBytes ? 1000 : 121000, proxyBytes);
      await settleBrowser({ request: value.request, credential: fixture.credential }, value.dependencies);
      const item = (await listPaidUsageExceptions({ prisma })).exceptions.find(
        (row) => row.dispatch_id === body.dispatch_id,
      )!;
      expect(item.product).toBe('nessie');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: smsIds.user } });
      const adminDomain = 'authentication.unlikeotherai.com';
      await prisma.domainRole.upsert({
        where: { domain_userId: { domain: adminDomain, userId: user.id } },
        create: { domain: adminDomain, userId: user.id, role: 'SUPERUSER' },
        update: { role: 'SUPERUSER' },
      });
      const operation = {
        dispatchId: body.dispatch_id,
        evidenceDigest: item.evidence_digest,
        idempotencyKey: createHash('sha256').update(body.dispatch_id).digest('hex'),
        reason: 'Reviewed terminal Browserbase receipt and capped the customer charge',
        actorUserId: user.id,
        actorTokenVersion: user.tokenVersion,
        adminDomain,
      };
      await expect(
        writeOffPaidUsageException({ ...operation, actorTokenVersion: user.tokenVersion + 1 }, { prisma }),
      ).rejects.toThrow('OPERATOR_REVOKED');
      const [first, second] = await Promise.all([
        writeOffPaidUsageException(operation, { prisma }),
        writeOffPaidUsageException(operation, { prisma }),
      ]);
      expect(first).toEqual(second);
      expect(first.collectible_microcredits).toBe(proxyBytes ? '2200000' : '4400000');
      expect(first.waived_microcredits).toBe(proxyBytes ? '0' : '2200000');
      expect(
        await prisma.billingCreditEntry.count({ where: { browserReservationId: reserved.reservation_id } }),
      ).toBe(1);
      expect(
        (await settleBrowser({ request: value.request, credential: fixture.credential }, value.dependencies))
          .state,
      ).toBe('settled');
      expect(
        (await listPaidUsageExceptions({ prisma })).exceptions.some(
          (row) => row.dispatch_id === body.dispatch_id,
        ),
      ).toBe(false);
      await expect(
        writeOffPaidUsageException({ ...operation, evidenceDigest: '0'.repeat(64) }, { prisma }),
      ).rejects.toThrow('EVIDENCE_CONFLICT');
    },
  );
  it('enforces one wallet balance while three admissions overlap at the provider boundary', async () => {
    const project = randomUUID();
    await prisma.billingBrowserPolicy.create({
      data: {
        serviceId: smsIds.service,
        projectId: project,
        providerUsdPerHour: '1000',
        roundingSeconds: 60,
        sourceUrl: fixture.policy.sourceUrl,
        validUntil: fixture.policy.validUntil,
        createdByUserId: smsIds.user,
      },
    });
    let arrivals = 0;
    let open!: () => void;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    const stripe = {
      ...fixture.stripe,
      accounts: {
        ...fixture.stripe.accounts,
        retrieveCurrent: async () => {
          arrivals += 1;
          if (arrivals === 3) open();
          await barrier;
          return fixture.stripe.accounts.retrieveCurrent();
        },
      },
    } as typeof fixture.stripe;
    const bodies = Array.from({ length: 3 }, () => request({ project_id: project }));
    const result = await Promise.allSettled(bodies.map((body) => reserve(body, { ...deps(), stripe })));
    expect(arrivals).toBe(3);
    expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(2);
    expect(result.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const account = await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: smsIds.credit } });
    expect(
      account.balanceMicrocredits - (await billingReservedMicrocredits(prisma, account.id)),
    ).toBeGreaterThanOrEqual(0n);
    for (const body of bodies) await release(body.dispatch_id);
  });
  it('prevents database edits to payer, tariff and settled receipt evidence', async () => {
    const body = request();
    const reserved = await reserve(body);
    await expect(
      prisma.billingBrowserReservation.update({
        where: { id: reserved.reservation_id },
        data: { maxDurationSeconds: 120 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingBrowserPolicy.update({
        where: { id: fixture.policy.id },
        data: { providerUsdPerHour: '0.01' },
      }),
    ).rejects.toThrow();
    await release(body.dispatch_id);
  });
  it('allows settlement after human revocation using the captured payer, but refuses a new claim', async () => {
    const first = request();
    await reserve(first);
    await claim(first.dispatch_id);
    const second = request();
    await reserve(second);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: smsIds.user } });
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: user.tokenVersion + 1 } });
    try {
      await expect(claim(second.dispatch_id)).rejects.toMatchObject({ statusCode: 401 });
      const value = await receipt(first.dispatch_id, 60001);
      expect(
        (await settleBrowser({ request: value.request, credential: fixture.credential }, value.dependencies))
          .state,
      ).toBe('settled');
      const row = await prisma.billingBrowserReservation.findUniqueOrThrow({
        where: { dispatchId: first.dispatch_id },
      });
      expect(
        row.actualAmount?.eq(
          new Prisma.Decimal('0.12').mul(120).div(3600).toDecimalPlaces(18, Prisma.Decimal.ROUND_UP),
        ),
      ).toBe(true);
    } finally {
      await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: user.tokenVersion } });
      await release(second.dispatch_id);
    }
  });
});
