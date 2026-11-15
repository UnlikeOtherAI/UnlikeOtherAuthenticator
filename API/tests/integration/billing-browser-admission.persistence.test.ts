import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { browserFinancialFixture } from '../helpers/browser-financial-fixture.js';
import { smsIds } from '../helpers/sms-financial-fixture.js';
import { reserveBrowser } from '../../src/services/billing-browser-reservation.service.js';
import { claimBrowser, releaseBrowserReservation } from '../../src/services/billing-browser-dispatch.service.js';
import { settleBrowser } from '../../src/services/billing-browser-receipt.service.js';

type Db = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
describe.skipIf(!process.env.DATABASE_URL)('browser payment admission', () => {
  let db: Db;
  let fixture: Awaited<ReturnType<typeof browserFinancialFixture>>;
  beforeEach(async () => {
    db = (await createTestDb())!;
    fixture = await browserFinancialFixture(db.prisma);
  });
  afterEach(async () => {
    await db?.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const dependencies = () => ({ prisma: db.prisma, stripe: fixture.stripe });
  const read = (dispatch_id: string) => ({ product: 'nessie', dispatch_id });
  async function reserve(dispatch_id: string) {
    return reserveBrowser({ credential: fixture.credential,
      actorToken: await fixture.actor('/billing/v1/browser/reservations'),
      request: { ...fixture.subject, dispatch_id, project_id: fixture.project,
        max_duration_seconds: 60, budget_context: null } }, dependencies());
  }
  const claim = (dispatch_id: string) => claimBrowser({ credential: fixture.credential,
    request: read(dispatch_id) }, dependencies());
  const release = (dispatch_id: string) => releaseBrowserReservation({ credential: fixture.credential,
    request: { ...read(dispatch_id), proof: 'no_provider_dispatch' } }, dependencies());
  function removeCard() {
    vi.spyOn(fixture.stripe.paymentMethods, 'list').mockResolvedValue({ data: [], has_more: false } as never);
  }
  async function holdSeats() {
    const p = db.prisma;
    const tariff = await p.billingTariff.create({ data: { serviceId: smsIds.service,
      key: 'regular-browser-seats', version: 1, name: 'Regular seats', currency: 'USD',
      mode: 'STANDARD', collectionMode: 'STRIPE', monthlyAmountMinor: 399n,
      monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED',
      anniversarySeats: true, usagePaymentMode: 'PREPAID' } });
    const assignment = await p.billingTariffAssignment.findFirstOrThrow({ where: {
      serviceId: smsIds.service, orgId: smsIds.org, scope: 'ORGANISATION' } });
    await p.billingTariffAssignment.update({ where: { id: assignment.id }, data: { tariffId: tariff.id } });
    await p.billingTariffTermEvent.create({ data: { serviceId: smsIds.service, source: 'ORGANISATION',
      scopeKey: smsIds.org, tariffId: tariff.id, assignmentId: assignment.id,
      effectiveFromMonth: new Date().toISOString().slice(0, 7), reason: 'browser-seat-admission-test' } });
    await p.billingNessieSeatTransition.update({ where: { orgId: smsIds.org }, data: { endedAt: new Date() } });
  }

  it.each(['card', 'seats'] as const)('refuses a funded wallet without %s eligibility before making any hold', async kind => {
    if (kind === 'card') removeCard(); else await holdSeats();
    const id = randomUUID();
    await expect(reserve(id)).rejects.toMatchObject({ statusCode: 402,
      message: kind === 'card' ? 'NESSIE_BILLING_SETUP_REQUIRED' : 'BILLING_SEAT_PAYMENT_REQUIRED' });
    expect(await db.prisma.billingBrowserReservation.findUnique({ where: { dispatchId: id } })).toBeNull();
    expect(await db.prisma.billingCreditBudgetDispatch.findUnique({ where: { dispatchId: id } })).toBeNull();
  });

  it.each(['card', 'seats'] as const)('refuses a new dispatch after losing %s eligibility and permits release', async kind => {
    const id = randomUUID();
    await reserve(id);
    if (kind === 'card') removeCard(); else await holdSeats();
    await expect(claim(id)).rejects.toMatchObject({ statusCode: 402,
      message: kind === 'card' ? 'NESSIE_BILLING_SETUP_REQUIRED' : 'BILLING_SEAT_PAYMENT_REQUIRED' });
    expect(await db.prisma.billingBrowserReservation.findUniqueOrThrow({ where: { dispatchId: id } }))
      .toMatchObject({ state: 'reserved', dispatchClaimedAt: null });
    await expect(release(id)).resolves.toEqual({ dispatch_id: id, released: true });
    expect((await claim(id)).can_dispatch).toBe(false);
  });

  it('settles incurred usage once after both card and seat eligibility are lost', async () => {
    const id = randomUUID();
    await reserve(id);
    expect((await claim(id)).can_dispatch).toBe(true);
    const row = await db.prisma.billingBrowserReservation.findUniqueOrThrow({ where: { dispatchId: id } });
    removeCard();
    await holdSeats();
    const ended = new Date(row.dispatchClaimedAt!.getTime() + 1000);
    const input = { credential: fixture.credential, request: { ...read(id), project_id: fixture.project,
      session_id: randomUUID(), status: 'COMPLETED' as const, started_at: row.dispatchClaimedAt!.toISOString(),
      ended_at: ended.toISOString(), proxy_bytes: 0 } };
    const deps = { ...dependencies(), now: () => new Date(ended.getTime() + 1000) };
    await expect(settleBrowser(input, deps)).resolves.toMatchObject({ state: 'settled', consumed_credits: '2.200000' });
    await expect(settleBrowser(input, deps)).resolves.toMatchObject({ state: 'settled', consumed_credits: '2.200000' });
    expect(await db.prisma.billingCreditEntry.count({ where: { browserReservationId: row.id } })).toBe(1);
  });
});
