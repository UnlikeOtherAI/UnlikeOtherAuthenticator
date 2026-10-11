import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSmsFxEvidence, smsFxWithinBand } from '../../src/services/billing-sms-fx-evidence.service.js';
import {
  runSmsPolicyRenewalCycle, smsRouteRenewalDecision,
} from '../../src/services/billing-sms-policy-renewal.service.js';

const account = `AC${'a'.repeat(32)}`;
const now = new Date('2026-10-12T06:00:00.000Z');
const ecb = (date: string, rate: string) => '<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">' +
  `<Cube><Cube time="${date}"><Cube currency="USD" rate="${rate}"/></Cube></Cube></gesmes:Envelope>`;

describe('the FX band rule', () => {
  it('accepts exactly the configured band around the last accepted rate, in both directions', () => {
    expect(smsFxWithinBand('1.1000', '1.155', 500)).toBe(true);
    expect(smsFxWithinBand('1.1000', '1.1550000001', 500)).toBe(false);
    expect(smsFxWithinBand('1.1000', '1.045', 500)).toBe(true);
    expect(smsFxWithinBand('1.1000', '1.0449', 500)).toBe(false);
    expect(smsFxWithinBand('1.1186', '1.1186', 0)).toBe(true);
    expect(smsFxWithinBand('1.1186', '1.1187', 0)).toBe(false);
    expect(smsFxWithinBand('1.1186', '1.2', 2000)).toBe(true);
  });
  it('refuses an invalid band or rate instead of approximating', () => {
    expect(() => smsFxWithinBand('1.1', '1.1', -1)).toThrow();
    expect(() => smsFxWithinBand('1.1', '1.1', 1.5)).toThrow();
    expect(() => smsFxWithinBand('1.1', '1e3', 500)).toThrow();
    expect(smsFxWithinBand('0', '1.1', 500)).toBe(false);
  });
});

describe('the route price rule', () => {
  it('renews only at or below the operator-attested account price', () => {
    expect(smsRouteRenewalDecision('0.056', '0.056')).toBe('renew');
    expect(smsRouteRenewalDecision('0.056', '0.0560')).toBe('renew');
    expect(smsRouteRenewalDecision('0.056', '0.0559')).toBe('renew');
    expect(smsRouteRenewalDecision('0.056', '0.0560000000000001')).toBe('price_rose');
    expect(smsRouteRenewalDecision(null, '0.0001')).toBe('needs_operator');
    expect(() => smsRouteRenewalDecision('0.056', '-0.01')).toThrow();
  });
});

// Every write the renewal job may make: appending evidence and opening or closing alerts.
const appendOnly = new Set(['findFirst', 'findUnique', 'findMany', 'create']);
function fakeDb(state: { fx: object[]; routes: Array<Record<string, unknown>> }) {
  const calls: string[] = [];
  const delegate = (name: string, methods: Record<string, (args: never) => unknown>) => new Proxy(methods, {
    get(target, method) {
      if (typeof method !== 'string') return Reflect.get(target, method);
      calls.push(`${name}.${method}`);
      if (name !== 'billingSmsPolicyAlert' && !appendOnly.has(method)) {
        throw new Error(`renewal job attempted ${name}.${method}`);
      }
      return target[method] ?? (() => { throw new Error(`unmodelled ${name}.${method}`); });
    },
  });
  const db = {
    $queryRaw: vi.fn(async () => []),
    $transaction: async (run: (tx: unknown) => unknown) => run(db),
    billingSmsFxSnapshot: delegate('billingSmsFxSnapshot', {
      findFirst: async () => state.fx[0] ?? null, findUnique: async () => null,
      create: async ({ data }: { data: object }) => { state.fx.unshift(data); return data; },
    }),
    billingSmsRoutePolicy: delegate('billingSmsRoutePolicy', {
      findMany: async () => state.routes, findFirst: async () => null,
      findUnique: async ({ where }: { where: { id: string } }) => state.routes.find((row) => row.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { state.routes.push(data); return data; },
    }),
    billingSmsPolicyAlert: delegate('billingSmsPolicyAlert', {
      create: async () => ({}), updateMany: async () => ({ count: 0 }),
    }),
  };
  return { db, calls };
}
const route = (overrides: Record<string, unknown>) => ({ id: 'route-root', accountSid: account, country: 'GB',
  direction: 'outbound', currency: 'USD', additionalPerSegment: new Prisma.Decimal('0.01'),
  additionalPerMessage: new Prisma.Decimal('0.002'), source: 'https://www.twilio.com/en-us/sms/pricing/gb',
  evidenceDigest: 'c'.repeat(64), expiresAt: new Date(now.getTime() + 3 * 86_400_000), acceptedBy: 'operator',
  acceptedByUserId: 'operator-1', acceptedAt: new Date(now.getTime() - 27 * 86_400_000), acceptanceReason: 'Accepted',
  providerPrice: new Prisma.Decimal('0.056'), renewalOfId: null, ...overrides });

describe('the renewal job only appends evidence', () => {
  beforeEach(() => { vi.stubEnv('BILLING_SMS_POLICY_AUTORENEW_FX_BAND_BPS', '500'); });
  afterEach(() => vi.unstubAllEnvs());

  it('adds a renewal-job FX record and a re-attested route without editing any accepted record', async () => {
    const lastFx = { id: 'fx-1', policy: 'ECB_REFERENCE_USD_PER_EUR_V1', sourceDigest: 'd'.repeat(64),
      rateDate: new Date('2026-10-08T00:00:00Z'), usdPerEur: new Prisma.Decimal('1.1186'),
      expiresAt: new Date('2026-10-15T00:00:00Z') };
    const original = route({});
    const state = { fx: [lastFx as object], routes: [original] };
    const { db, calls } = fakeDb(state);
    const notify = vi.fn(async () => undefined);
    const result = await runSmsPolicyRenewalCycle({ prisma: db as never, now: () => now, notify,
      readFx: async () => parseSmsFxEvidence(ecb('2026-10-09', '1.1201'), now),
      provider: () => ({ configuration: { accountSid: account } as never, price: async () => ({
        amount: '0.0550', currency: 'USD', country: 'GB', observedAt: now,
        source: 'https://pricing.twilio.com/v1/Messaging/Countries/GB' }) }) });
    expect(result).toEqual({ fx: 'accepted', routes: { checked: 1, renewed: 1, alerted: 0 } });
    expect(state.fx[0]).toMatchObject({ acceptedBy: 'renewal_job', acceptedByUserId: null, usdPerEur: '1.1201',
      expiresAt: new Date('2026-10-16T00:00:00Z') });
    expect(state.routes[1]).toMatchObject({ acceptedBy: 'renewal_job', acceptedByUserId: null,
      renewalOfId: 'route-root', providerPrice: '0.0550', additionalPerSegment: '0.01',
      additionalPerMessage: '0.002', source: original.source,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000) });
    expect(state.routes[1]?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(state.routes[1]?.evidenceDigest).not.toBe(original.evidenceDigest);
    expect(state.routes[0]).toBe(original); expect(original).toMatchObject({ acceptedBy: 'operator', renewalOfId: null });
    expect(calls.filter((call) => /\.(update|upsert|delete)/.test(call) && !call.startsWith('billingSmsPolicyAlert'))).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('raises alerts instead of renewing a price rise, a missing baseline or an out-of-band rate', async () => {
    const lastFx = { id: 'fx-1', policy: 'ECB_REFERENCE_USD_PER_EUR_V1', sourceDigest: 'd'.repeat(64),
      rateDate: new Date('2026-10-08T00:00:00Z'), usdPerEur: new Prisma.Decimal('1.1186'),
      expiresAt: new Date('2026-10-15T00:00:00Z') };
    const state = { fx: [lastFx as object], routes: [route({}), route({ id: 'manual', country: 'CZ', providerPrice: null })] };
    const { db } = fakeDb(state);
    const notify = vi.fn(async () => undefined);
    const result = await runSmsPolicyRenewalCycle({ prisma: db as never, now: () => now, notify,
      readFx: async () => parseSmsFxEvidence(ecb('2026-10-09', '1.2000'), now),
      provider: () => ({ configuration: { accountSid: account } as never, price: async (country: string) => ({
        amount: '0.0561', currency: 'USD', country, observedAt: now, source: 'https://pricing.twilio.com/v1/x' }) }) });
    expect(result).toEqual({ fx: 'alerted', routes: { checked: 2, renewed: 0, alerted: 2 } });
    expect(state.fx).toHaveLength(1); expect(state.routes).toHaveLength(2);
    expect(notify.mock.calls.map(([condition]) => (condition as { kind: string }).kind))
      .toEqual(['fx_outside_band', 'route_price_rose', 'route_needs_operator']);
    expect((notify.mock.calls[1]?.[0] as { message: string }).message).toContain('from USD 0.056 to 0.0561');
  });
});
