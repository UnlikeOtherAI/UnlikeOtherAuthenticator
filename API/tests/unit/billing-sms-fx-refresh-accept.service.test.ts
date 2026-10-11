import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSmsFxEvidence } from '../../src/services/billing-sms-fx-evidence.service.js';
import { acceptSmsFxRefresh } from '../../src/services/billing-sms-policy-admin.service.js';

const tx = vi.hoisted(() => ({ $queryRaw: vi.fn(),
  billingSmsFxSnapshot: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() } }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => ({
  $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
}) }));
const actor = { userId: 'operator-1', tokenVersion: 3, email: 'operator@example.test', domain: 'admin.example.com' };
const now = new Date('2026-10-11T12:00:00.000Z');
const xml = (rate: string) => '<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">' +
  `<Cube><Cube time="2026-10-09"><Cube currency="USD" rate="${rate}"/></Cube></Cube></gesmes:Envelope>`;
const last = { usdPerEur: new Prisma.Decimal('1.1186') };
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv('ADMIN_AUTH_DOMAIN', actor.domain);
  tx.$queryRaw.mockResolvedValue([{ id: actor.userId, tokenVersion: 3, email: actor.email, role: 'SUPERUSER' }]);
  tx.billingSmsFxSnapshot.findUnique.mockResolvedValue(null);
  tx.billingSmsFxSnapshot.create.mockImplementation(async ({ data }) => ({ id: 'fx-2', ...data }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Refresh and accept', () => {
  it('accepts an in-band rate under the operator subject and authority locks with a generated reason', async () => {
    tx.billingSmsFxSnapshot.findFirst.mockResolvedValue(last);
    await acceptSmsFxRefresh(actor, async () => parseSmsFxEvidence(xml('1.1201'), now));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    expect(tx.billingSmsFxSnapshot.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      usdPerEur: '1.1201', acceptedBy: 'operator', acceptedByUserId: actor.userId, acceptedAt: now,
      expiresAt: new Date('2026-10-16T00:00:00.000Z'),
      acceptanceReason: expect.stringContaining('within ±5.00% of the last accepted 1.1186') }) });
  });
  it('uses the configured band, and leaves the first rate and an out-of-band rate to the manual review', async () => {
    tx.billingSmsFxSnapshot.findFirst.mockResolvedValue(null);
    await expect(acceptSmsFxRefresh(actor, async () => parseSmsFxEvidence(xml('1.1201'), now)))
      .rejects.toThrow('BILLING_SMS_FX_BASELINE_REQUIRED');
    tx.billingSmsFxSnapshot.findFirst.mockResolvedValue(last);
    await expect(acceptSmsFxRefresh(actor, async () => parseSmsFxEvidence(xml('1.1800'), now)))
      .rejects.toThrow('BILLING_SMS_FX_OUTSIDE_BAND');
    vi.stubEnv('BILLING_SMS_POLICY_AUTORENEW_FX_BAND_BPS', '1000');
    await acceptSmsFxRefresh(actor, async () => parseSmsFxEvidence(xml('1.1800'), now));
    expect(tx.billingSmsFxSnapshot.create).toHaveBeenCalledTimes(1);
  });
  it('refuses a revoked operator before writing', async () => {
    tx.billingSmsFxSnapshot.findFirst.mockResolvedValue(last);
    tx.$queryRaw.mockResolvedValue([{ tokenVersion: 4, email: actor.email, role: 'SUPERUSER' }]);
    await expect(acceptSmsFxRefresh(actor, async () => parseSmsFxEvidence(xml('1.1201'), now)))
      .rejects.toThrow('AUTHORITY_REQUIRED');
    expect(tx.billingSmsFxSnapshot.create).not.toHaveBeenCalled();
  });
});
