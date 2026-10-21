import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({ db: {} as Record<string, unknown>, fetch: vi.fn() }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => fixtures.db }));
vi.mock('../../src/services/enterprise-http.service.js', () => ({ enterpriseFetch: fixtures.fetch }));
vi.mock('../../src/services/enterprise-secret.service.js', () => ({ openEnterpriseSecret: async () => 'test-key' }));
import { deliverEnterpriseRevocations } from '../../src/services/org-sso-delivery.service.js';

describe('durable revocation acknowledgement', () => {
  const consumer = { clientDomain: 'product.example.com', keyId: 'a', encryptedSecret: 'envelope-a',
    destination: 'https://product.example.com/revocations', enabled: true, acknowledgedAt: new Date(),
    deliveredSequence: 0n, failureCount: 0 };
  const event = { id: 'event-a', sequence: 1n, clientDomain: consumer.clientDomain, scope: 'user',
    userId: 'user-a', orgId: null, teamId: null, connectionId: null, revision: 1, occurredAt: new Date() };
  let update: ReturnType<typeof vi.fn>;
  let receipt: ReturnType<typeof vi.fn>;
  let current: typeof consumer;
  beforeEach(() => {
    current = { ...consumer }; update = vi.fn().mockResolvedValue({ count: 1 }); receipt = vi.fn();
    const tx = { orgRevocationConsumer: { updateMany: update }, orgRevocationDelivery: { upsert: receipt } };
    fixtures.db = { orgRevocationConsumer: { findMany: async () => [consumer],
      findUniqueOrThrow: async () => current, updateMany: update },
    orgRevocationEvent: { findMany: async () => [event] }, $transaction: async (run: (db: unknown) => unknown) => run(tx) };
    fixtures.fetch.mockReset();
  });
  it.each(['<html>ok</html>', '{}', JSON.stringify({ ok: true, version: 1, event_id: 'foreign' }), ''])
    ('retries malformed or unrelated acknowledgement without advancing: %s', async (body) => {
      fixtures.fetch.mockResolvedValue(body);
      await deliverEnterpriseRevocations();
      expect(receipt).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0].data).not.toHaveProperty('deliveredSequence');
      expect(update.mock.calls[0][0].data.failureCount).toBe(1);
    });
  it('records only an exact durable event acknowledgement', async () => {
    fixtures.fetch.mockResolvedValue(JSON.stringify({ ok: true, version: 1, event_id: event.id }));
    await deliverEnterpriseRevocations();
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toMatchObject({ encryptedSecret: consumer.encryptedSecret,
      destination: consumer.destination, acknowledgedAt: consumer.acknowledgedAt });
    expect(update.mock.calls[0][0].data.deliveredSequence).toBe(1n);
  });
  it('does not send a batch captured before same-ID key replacement', async () => {
    current.encryptedSecret = 'envelope-new';
    await deliverEnterpriseRevocations();
    expect(fixtures.fetch).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });
  it('guards cursor writes against replacement while the receiver is acknowledging', async () => {
    fixtures.fetch.mockImplementation(async () => {
      current.encryptedSecret = 'envelope-new'; update.mockResolvedValue({ count: 0 });
      return JSON.stringify({ ok: true, version: 1, event_id: event.id });
    });
    await deliverEnterpriseRevocations();
    expect(update.mock.calls[0][0].where.encryptedSecret).toBe('envelope-a');
    expect(receipt).not.toHaveBeenCalled();
  });
});
