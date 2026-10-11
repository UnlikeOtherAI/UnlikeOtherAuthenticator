import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptSmsCountryPolicy, previewSmsCountryPolicy,
} from '../../src/services/billing-sms-country-policy.service.js';

const tx = vi.hoisted(() => ({ $queryRaw: vi.fn(),
  billingSmsRoutePolicy: { create: vi.fn(), findFirst: vi.fn() } }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => ({
  $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
}) }));
const actor = { userId: 'operator-1', tokenVersion: 3, email: 'operator@example.test', domain: 'admin.example.com' };
const account = `AC${'b'.repeat(32)}`;
const now = new Date('2026-10-11T12:00:00.000Z');
const prices: Record<string, string> = { outbound: '0.0560', inbound: '0.0075' };
const provider = (currency = 'USD') => ({ configuration: { accountSid: account } as never,
  price: vi.fn(async (country: string, direction: string) => ({ amount: prices[direction] as string, currency, country,
    observedAt: now, source: `https://pricing.twilio.com/v1/Messaging/Countries/${country}` })) });
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv('ADMIN_AUTH_DOMAIN', actor.domain); vi.stubEnv('ADMIN_ACCESS_TOKEN_SECRET', 'synthetic-admin-secret-with-enough-length');
  tx.$queryRaw.mockResolvedValue([{ id: actor.userId, tokenVersion: 3, email: actor.email, role: 'SUPERUSER' }]);
  tx.billingSmsRoutePolicy.findFirst.mockResolvedValue(null);
  tx.billingSmsRoutePolicy.create.mockImplementation(async ({ data }) => ({ id: `route-${data.direction}`, ...data }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Add country', () => {
  it('reads both directions for the configured account and binds the generated evidence by hash', async () => {
    const preview = await previewSmsCountryPolicy(actor, 'GB', { provider: provider(), now: () => now });
    const [outbound, inbound] = preview.evidence.routes;
    expect(preview.evidence).toMatchObject({ country: 'GB', account_sid: account, validity_days: 30 });
    expect(outbound).toMatchObject({ direction: 'outbound', account_sid: account, currency: 'USD',
      additional_per_segment: '0.01', additional_per_message: '0.002', provider_price: '0.0560',
      source: 'https://www.twilio.com/en-us/sms/pricing/gb', expires_at: '2026-11-10T12:00:00.000Z' });
    expect(inbound).toMatchObject({ direction: 'inbound', additional_per_segment: '0.007', provider_price: '0.0075' });
    // The same canonical import order the manual route preview hashes.
    const imported = { account_sid: account, country: 'GB', direction: 'outbound', currency: 'USD',
      additional_per_segment: '0.01', additional_per_message: '0.002', source: outbound.source,
      evidence: preview.evidence_documents[0], expires_at: outbound.expires_at };
    expect(outbound.evidence_digest).toBe(createHash('sha256').update(JSON.stringify(imported)).digest('hex'));
    expect(tx.billingSmsRoutePolicy.create).not.toHaveBeenCalled();
  });
  it('refuses a provider currency the rule does not document', async () => {
    await expect(previewSmsCountryPolicy(actor, 'IE', { provider: provider('EUR'), now: () => now }))
      .rejects.toThrow('BILLING_SMS_ROUTE_RULE_UNSUPPORTED');
    await expect(previewSmsCountryPolicy(actor, 'gb', { provider: provider(), now: () => now })).rejects.toThrow();
  });
  it('accepts both routes under the operator with the recorded price and a generated reason', async () => {
    const preview = await previewSmsCountryPolicy(actor, 'CZ', { provider: provider(), now: () => now });
    const accepted = await acceptSmsCountryPolicy(actor, preview.preview_token);
    expect(accepted).toHaveLength(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    for (const [direction, price] of [['outbound', '0.0560'], ['inbound', '0.0075']]) {
      expect(tx.billingSmsRoutePolicy.create).toHaveBeenCalledWith({ data: expect.objectContaining({ direction,
        country: 'CZ', accountSid: account, acceptedBy: 'operator', acceptedByUserId: actor.userId,
        providerPrice: price, renewalOfId: null, acceptedAt: now,
        acceptanceReason: expect.stringContaining('Add country CZ') }) });
    }
    await expect(acceptSmsCountryPolicy({ ...actor, tokenVersion: 4 }, preview.preview_token)).rejects.toThrow('PREVIEW_INVALID');
  });
});
