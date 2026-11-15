import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const billing = vi.hoisted(() => ({ read: vi.fn(), collect: vi.fn() }));
vi.mock('../../src/services/billing-invitation-seat.service.js', () => ({
  invitationFundingRequest: billing.read, collectInvitationPayment: billing.collect,
}));
import { withInvitationDelivery } from '../../src/routes/org/invitation-delivery.js';

describe('committed invitation delivery', () => {
  beforeEach(() => vi.resetAllMocks());
  function fixture() {
    const events: string[] = [];
    const transactions: object[] = [];
    const request = { withTenantTx: async (work: (tx: object) => Promise<unknown>) => {
      const tx = {}; transactions.push(tx);
      events.push('begin');
      try { const result = await work(tx); events.push('commit'); return result; }
      catch (error) { events.push('rollback'); throw error; }
    } } as unknown as FastifyRequest;
    billing.read.mockImplementation(async () => { events.push('read'); return { inviteId: 'held' }; });
    billing.collect.mockImplementation(async () => { events.push('collect'); });
    return { request, events, transactions };
  }
  it('commits the intent before provider IO and mints the link in a fresh tenant transaction', async () => {
    const { request, events, transactions } = fixture();
    const result = await withInvitationDelivery(request, async (tx, defer) => {
      events.push('create');
      defer('held', async deliveryTx => {
        expect(deliveryTx).not.toBe(tx); events.push('mail');
      });
      return { id: 'held' };
    });
    expect(result).toEqual({ id: 'held' });
    expect(events).toEqual(['begin', 'create', 'commit', 'begin', 'read', 'commit', 'collect', 'begin', 'mail', 'commit']);
    expect(transactions).toHaveLength(3);
  });
  it('retains the committed invitation and sends no mail when collection fails', async () => {
    const { request, events } = fixture();
    billing.collect.mockRejectedValue(new Error('payment required'));
    const deliver = vi.fn();
    await expect(withInvitationDelivery(request, async (_tx, defer) => {
      events.push('create'); defer('held', deliver);
    })).rejects.toThrow('payment required');
    expect(events).toEqual(['begin', 'create', 'commit', 'begin', 'read', 'commit']);
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not collect when the invitation transaction rolls back', async () => {
    const { request, events } = fixture();
    await expect(withInvitationDelivery(request, async (_tx, defer) => {
      defer('held', vi.fn()); throw new Error('authority revoked');
    })).rejects.toThrow('authority revoked');
    expect(events).toEqual(['begin', 'rollback']);
    expect(billing.collect).not.toHaveBeenCalled();
  });
  it('keeps the paid intent if the final token transaction refuses a revoked invitation', async () => {
    const { request, events } = fixture();
    await expect(withInvitationDelivery(request, async (_tx, defer) => {
      defer('held', async () => { throw new Error('invitation revoked'); });
    })).rejects.toThrow('invitation revoked');
    expect(billing.collect).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe('rollback');
    expect(events.filter(event => event === 'commit')).toHaveLength(2);
  });
});
