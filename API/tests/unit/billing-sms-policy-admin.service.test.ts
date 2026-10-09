import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { acceptSmsFxPolicy, acceptSmsRoutePolicy, previewSmsFxPolicy, previewSmsRoutePolicy,
  SmsRoutePolicyImportSchema, serializeSmsFxPolicy } from '../../src/services/billing-sms-policy-admin.service.js';

const tx = vi.hoisted(() => ({ $queryRaw: vi.fn(),
  billingSmsFxSnapshot: { create: vi.fn(), findUnique: vi.fn() },
  billingSmsRoutePolicy: { create: vi.fn(), findFirst: vi.fn() } }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => ({
  $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
}) }));
const actor = { userId: 'operator-1', tokenVersion: 3, email: 'operator@example.test', domain: 'admin.example.com' };
const now = new Date('2026-10-08T12:00:00.000Z');
const xml = '<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">' +
  '<Cube><Cube time="2026-10-08"><Cube currency="USD" rate="1.1186"/></Cube></Cube></gesmes:Envelope>';
const route = { account_sid: `AC${'a'.repeat(32)}`, country: 'GB', direction: 'outbound', currency: 'USD',
  additional_per_segment: '0.003000000000000001', additional_per_message: '0.001',
  source: 'https://provider.example/account-specific-terms',
  evidence: 'Synthetic documented carrier and failed processing fee bounds for account.',
  expires_at: '2026-10-10T12:00:00Z' } as const;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv('ADMIN_AUTH_DOMAIN', actor.domain); vi.stubEnv('ADMIN_ACCESS_TOKEN_SECRET', 'synthetic-admin-secret-with-enough-length');
  tx.$queryRaw.mockResolvedValue([{ id: actor.userId, tokenVersion: 3, email: actor.email, role: 'SUPERUSER' }]);
  tx.billingSmsFxSnapshot.findUnique.mockResolvedValue(null); tx.billingSmsRoutePolicy.findFirst.mockResolvedValue(null);
  tx.billingSmsFxSnapshot.create.mockImplementation(async ({ data }) => ({ id: 'fx-1', ...data }));
  tx.billingSmsRoutePolicy.create.mockImplementation(async ({ data }) => ({ id: 'route-1', ...data }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('private immutable operator SMS policy acceptance', () => {
  it('refuses stored FX provenance that differs from the displayed fixed source', async () => {
    const preview = await previewSmsFxPolicy(actor, xml);
    const accepted = await acceptSmsFxPolicy(actor, preview.preview_token, 'Accepted dated informational reference policy.');
    expect(() => serializeSmsFxPolicy({ ...accepted, source: 'https://untrusted.example/rates' })).toThrow('PROVENANCE_INVALID');
    expect(() => serializeSmsFxPolicy({ ...accepted, policy: 'OTHER_REFERENCE' })).toThrow('PROVENANCE_INVALID');
  });
  it('reviews dated source/hash and persists exact FX only after locked explicit acceptance', async () => {
    const preview = await previewSmsFxPolicy(actor, xml);
    expect(preview.evidence).toMatchObject({ rate_date: '2026-10-08', usd_per_eur: '1.1186',
      source_digest: createHash('sha256').update(xml).digest('hex'), expires_at: '2026-10-15T00:00:00.000Z' });
    expect(tx.billingSmsFxSnapshot.create).not.toHaveBeenCalled();
    await acceptSmsFxPolicy(actor, preview.preview_token, 'Accepted dated informational reference policy.');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    expect(tx.billingSmsFxSnapshot.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      usdPerEur: '1.1186', acceptedByUserId: actor.userId, acceptedAt: now,
      acceptanceReason: 'Accepted dated informational reference policy.', expiresAt: new Date('2026-10-15T00:00:00Z'),
    }) });
  });
  it('hashes every bound dimension and retains exact decimal strings without writes in preview', async () => {
    const preview = await previewSmsRoutePolicy(actor, route);
    expect(preview.evidence).toMatchObject({ additional_per_segment: route.additional_per_segment,
      evidence_digest: createHash('sha256').update(JSON.stringify(route)).digest('hex') });
    const changed = await previewSmsRoutePolicy(actor, { ...route, country: 'US' });
    expect(changed.evidence).not.toEqual(preview.evidence);
    await acceptSmsRoutePolicy(actor, preview.preview_token, 'Verified both fee bounds with source-supported expiry.');
    expect(tx.billingSmsRoutePolicy.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      country: 'GB', direction: 'outbound', currency: 'USD', accountSid: route.account_sid,
      additionalPerSegment: route.additional_per_segment, additionalPerMessage: '0.001',
      evidenceDigest: createHash('sha256').update(JSON.stringify(route)).digest('hex'),
    }) });
  });
  it('refuses tampering, another operator, prior epoch and mismatched preview purpose', async () => {
    const preview = await previewSmsFxPolicy(actor, xml);
    for (const [user, token] of [[{ ...actor, userId: 'other' }, preview.preview_token],
      [{ ...actor, tokenVersion: 4 }, preview.preview_token], [actor, `${preview.preview_token}tampered`]] as const) {
      await expect(acceptSmsFxPolicy(user, token, 'Recorded acceptance reason')).rejects.toThrow('PREVIEW_INVALID');
    }
    await expect(acceptSmsRoutePolicy(actor, preview.preview_token, 'Recorded acceptance reason')).rejects.toThrow('PREVIEW_INVALID');
    expect(tx.billingSmsFxSnapshot.create).not.toHaveBeenCalled();
  });
  it('refuses stale route evidence, five-minute review expiry and expiry while waiting on locks', async () => {
    await expect(previewSmsRoutePolicy(actor, { ...route, expires_at: now.toISOString() })).rejects.toThrow('POLICY_EXPIRED');
    const preview = await previewSmsRoutePolicy(actor, route);
    vi.setSystemTime(new Date(now.getTime() + 5 * 60_000));
    await expect(acceptSmsRoutePolicy(actor, preview.preview_token, 'Recorded acceptance reason')).rejects.toThrow('PREVIEW_INVALID');
    vi.setSystemTime(now);
    tx.$queryRaw.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 5 * 60_000));
      return [{ tokenVersion: 3, email: actor.email, role: 'SUPERUSER' }];
    });
    await expect(acceptSmsRoutePolicy(actor, preview.preview_token, 'Recorded acceptance reason')).rejects.toThrow('PREVIEW_INVALID');
    expect(tx.billingSmsRoutePolicy.create).not.toHaveBeenCalled();
  });
  it('refuses revoked current authority and returns exact immutable replay without extending expiry', async () => {
    const preview = await previewSmsFxPolicy(actor, xml);
    tx.$queryRaw.mockResolvedValue([{ tokenVersion: 4, email: actor.email, role: 'SUPERUSER' }]);
    await expect(acceptSmsFxPolicy(actor, preview.preview_token, 'Recorded acceptance reason')).rejects.toThrow('AUTHORITY_REQUIRED');
    tx.$queryRaw.mockResolvedValue([{ tokenVersion: 3, email: actor.email, role: 'SUPERUSER' }]);
    const original = { id: 'fx-existing', acceptanceReason: 'Original acceptance', acceptedAt: now };
    tx.billingSmsFxSnapshot.findUnique.mockResolvedValue(original);
    expect(await acceptSmsFxPolicy(actor, preview.preview_token, 'Different retry reason')).toBe(original);
    expect(tx.billingSmsFxSnapshot.create).not.toHaveBeenCalled();
  });
  it('refuses missing bounds, float precision overflow and unsupported dimensions instead of defaulting to zero', () => {
    for (const change of [{ additional_per_segment: undefined }, { additional_per_message: '-0.01' },
      { additional_per_segment: '0.0000000000000000001' }, { additional_per_message: '1e-3' },
      { currency: 'GBP' }, { country: '*' }, { evidence: '' }, { evidence_digest: 'a'.repeat(64) }]) {
      expect(SmsRoutePolicyImportSchema.safeParse({ ...route, ...change }).success).toBe(false);
    }
  });
});
