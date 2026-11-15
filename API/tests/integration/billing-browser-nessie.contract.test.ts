import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNessieContract } from '../helpers/browser-nessie-contract.js';
import { smsIds } from '../helpers/sms-financial-fixture.js';
import { billingReservedMicrocredits } from '../../src/services/billing-credit-holds.service.js';
import { generateBillingAppKey, digestBillingAppKey } from '../../src/utils/billing-app-key.js';

const enabled = process.env.DATABASE_URL && process.env.NESSIE_BROWSER_CONTRACT_ROOT
  && process.env.NESSIE_BROWSER_CONTRACT_DATABASE_URL;
describe.skipIf(!enabled)('Nessie production adapter through real UOA browser routes', () => {
  let f: Awaited<ReturnType<typeof browserNessieContract>>;
  let cleanup: (() => Promise<void>) | undefined;
  beforeEach(async () => { f = await browserNessieContract(); cleanup = f.cleanup; });
  afterEach(async () => { try { await cleanup?.(); } finally { cleanup = undefined; } });

  it('reserves before create, joins without another hold, and retries a lost receipt without another debit', async () => {
    expect((await f.nessie.quote()).customer_price_per_minute).toBe('0.002200000000000000');
    const opened = await f.nessie.open({ shared: true });
    const joined = await f.nessie.open({ shared: true, asAgent: true });
    expect(joined).toMatchObject({ browserId: opened.browserId, joined: true });
    const row = await f.db.prisma.billingBrowserReservation.findUniqueOrThrow({ where: { dispatchId: opened.browserId } });
    expect(row.reservedMicrocredits).toBe(6600000n);
    expect(f.nessie.providerRows()).toHaveLength(1);
    expect(f.statuses.filter(x => x.path.endsWith('/reservations'))).toHaveLength(1);
    vi.setSystemTime(new Date(Date.parse(f.nessie.providerRows()[0]!.startedAt) + 60_000));
    await f.nessie.release(opened.sessionId);
    expect(await billingReservedMicrocredits(f.db.prisma, smsIds.credit)).toBe(6600000n);
    f.loseNextReceipt();
    await f.nessie.release(joined.sessionId);
    expect(await f.nessie.readBrowser(opened.browserId)).toMatchObject({ status: 'released', billingState: 'reserved' });
    await f.nessie.reconcile(opened.browserId);
    expect(await f.nessie.readBrowser(opened.browserId)).toMatchObject({ billingState: 'settled' });
    const entries = await f.db.prisma.billingCreditEntry.findMany({ where: { browserReservationId: row.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ attributedUserId: smsIds.user, amountMicrocredits: 2200000n,
      kind: 'BROWSER_PREPAID_USAGE', direction: 'DEBIT' });
    expect(await billingReservedMicrocredits(f.db.prisma, smsIds.credit)).toBe(0n);
    expect((await f.db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: smsIds.credit } }))
      .balanceMicrocredits).toBe(4400000n);
    expect(f.statuses.filter(x => x.path.endsWith('/receipt') && x.status === 200)).toHaveLength(2);
  });

  it.each([[60_000, 2200000n], [60_001, 4400000n]] as const)(
    'rates a %i ms provider receipt using the frozen policy', async (milliseconds, debit) => {
      const opened = await f.nessie.open();
      vi.setSystemTime(new Date(Date.parse(f.nessie.providerRows()[0]!.startedAt) + milliseconds));
      await f.nessie.release(opened.sessionId);
      const row = await f.db.prisma.billingBrowserReservation.findUniqueOrThrow({ where: { dispatchId: opened.browserId } });
      expect(row).toMatchObject({ state: 'settled', debitedMicrocredits: debit,
        userId: smsIds.user, teamId: smsIds.team, policyId: f.f.policy.id });
    },
  );

  it('refuses unfunded concurrent opens and admits an explicit retry after unused funds are released', async () => {
    const attempts = await Promise.allSettled([f.nessie.open({ seconds: 60 }), f.nessie.open({ seconds: 60 })]);
    const accepted = attempts.find(x => x.status === 'fulfilled');
    const refused = attempts.find(x => x.status === 'rejected');
    expect(accepted?.status).toBe('fulfilled');
    expect(refused?.status === 'rejected' && refused.reason.code).toBe('CLOUD_BROWSER_INSUFFICIENT_CREDITS');
    expect(f.nessie.providerRows()).toHaveLength(1);
    if (accepted?.status !== 'fulfilled') throw new Error('Expected one funded session');
    await f.nessie.release(accepted.value.sessionId);
    const retry = await f.nessie.open({ seconds: 60 });
    await f.nessie.release(retry.sessionId);
    expect(f.nessie.providerRows()).toHaveLength(2);
    expect(await billingReservedMicrocredits(f.db.prisma, smsIds.credit)).toBe(0n);
  });

  it('refuses revoked human authority but settles incurred usage against its original payer', async () => {
    const opened = await f.nessie.open();
    await f.db.prisma.user.update({ where: { id: smsIds.user }, data: { tokenVersion: 1 } });
    await expect(f.nessie.open()).rejects.toMatchObject({ code: 'CLOUD_BROWSER_BILLING_ACCESS_REQUIRED' });
    expect(f.nessie.providerRows()).toHaveLength(1);
    await f.nessie.release(opened.sessionId);
    const row = await f.db.prisma.billingBrowserReservation.findUniqueOrThrow({ where: { dispatchId: opened.browserId } });
    expect(row).toMatchObject({ state: 'settled', userId: smsIds.user, actorTokenVersion: 0 });
  });

  it('rejects a lifecycle key and wrong actor issuer before any provider creation', async () => {
    const correct = f.env.UOA_BROWSER_RUNTIME_APP_KEY_NESSIE;
    const wrong = generateBillingAppKey();
    await f.db.prisma.billingAppKey.update({ where: { id: smsIds.lifecycle }, data: { secretDigest: digestBillingAppKey(wrong) } });
    f.env.UOA_BROWSER_RUNTIME_APP_KEY_NESSIE = wrong;
    await expect(f.nessie.open()).rejects.toMatchObject({ code: 'CLOUD_BROWSER_BILLING_SETUP_REQUIRED' });
    f.env.UOA_BROWSER_RUNTIME_APP_KEY_NESSIE = correct;
    f.env.NESSIE_API_PUBLIC_URL = 'https://wrong-issuer.example.com';
    await expect(f.nessie.open()).rejects.toBeDefined();
    expect(f.nessie.providerRows()).toHaveLength(0);
  });

  it('finds the original provider session after a lost create response and settles it on recovery', async () => {
    f.nessie.loseNextCreate();
    await expect(f.nessie.open({ seconds: 60 })).rejects.toBeDefined();
    const provider = f.nessie.providerRows()[0]!;
    vi.setSystemTime(new Date(Date.parse(provider.startedAt) + 60_000));
    await f.nessie.reap();
    await f.nessie.reconcile(provider.userMetadata.nessieBrowserId);
    expect(f.nessie.providerRows()).toHaveLength(1);
    expect(await f.nessie.readBrowser(provider.userMetadata.nessieBrowserId)).toMatchObject({ billingState: 'settled' });
    expect(await f.db.prisma.billingCreditEntry.count({ where: { kind: 'BROWSER_PREPAID_USAGE' } })).toBe(1);
  });
});
