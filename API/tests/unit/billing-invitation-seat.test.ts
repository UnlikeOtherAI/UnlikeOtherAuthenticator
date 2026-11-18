import { describe, expect, it, vi } from 'vitest';
import {
  collectInvitationPayment, invitationFundingRequest, requireFundedInvitation,
} from '../../src/services/billing-invitation-seat.service.js';

function fixture({ funded = false, required = true, root = null as string | null } = {}) {
  const query = vi.fn().mockResolvedValue([{ ready: funded }]);
  const prisma = {
    teamInvite: { findUnique: vi.fn().mockResolvedValue({
      orgId: 'org', teamId: 'team', billingSeatRequired: required, billingSeatSourceInviteId: root,
    }) },
    $queryRaw: query,
  };
  const cardOnFile = vi.fn().mockResolvedValue(undefined);
  const collect = vi.fn().mockResolvedValue(0);
  const deps = { admin: prisma as never, cardOnFile, collect };
  return { prisma, query, cardOnFile, collect, deps,
    read: () => invitationFundingRequest(prisma as never, 'current-invitation') };
}

describe('invitation payment collection admission', () => {
  it.each([null, 'original-invitation'])('reuses a funded seat without a card or provider IO: %s', async root => {
    const f = fixture({ funded: true, root });
    f.cardOnFile.mockRejectedValue(new Error('NESSIE_BILLING_SETUP_REQUIRED'));
    const funding = await f.read();
    expect(funding).toMatchObject({ funded: true, inviteId: root ?? 'current-invitation' });
    expect(f.query.mock.calls[0]?.slice(1)).toEqual(['current-invitation']);
    await collectInvitationPayment(funding, f.deps);
    expect(f.cardOnFile).not.toHaveBeenCalled();
    expect(f.collect).not.toHaveBeenCalled();
  });

  it('still requires billing setup for an unfunded replacement and retains its original collection target', async () => {
    const f = fixture({ root: 'original-invitation' });
    const funding = await f.read();
    f.cardOnFile.mockRejectedValueOnce(new Error('NESSIE_BILLING_SETUP_REQUIRED'));
    await expect(collectInvitationPayment(funding, f.deps)).rejects.toThrow('NESSIE_BILLING_SETUP_REQUIRED');
    expect(f.collect).not.toHaveBeenCalled();
    await collectInvitationPayment(funding, f.deps);
    expect(f.collect).toHaveBeenCalledExactlyOnceWith({ prisma: f.prisma, inviteId: 'original-invitation' });
    expect(f.cardOnFile).toHaveBeenLastCalledWith({
      product: 'nessie', organisationId: 'org', teamId: 'team',
    }, f.prisma);
  });

  it('does not treat a missing payment verdict as paid', async () => {
    const f = fixture();
    f.query.mockResolvedValue([]);
    expect((await f.read()).funded).toBe(false);
    await expect(requireFundedInvitation(f.prisma as never, 'current-invitation'))
      .rejects.toMatchObject({ statusCode: 402, message: 'BILLING_SEAT_PAYMENT_REQUIRED' });
  });

  it('rechecks current coverage before delivery even after a successful funding read', async () => {
    const f = fixture({ funded: true });
    const funding = await f.read();
    await collectInvitationPayment(funding, f.deps);
    f.query.mockResolvedValue([{ ready: false }]);
    await expect(requireFundedInvitation(f.prisma as never, 'current-invitation'))
      .rejects.toMatchObject({ statusCode: 402, message: 'BILLING_SEAT_PAYMENT_REQUIRED' });
  });

  it('leaves an invitation without a paid-seat requirement unchanged', async () => {
    const f = fixture({ required: false });
    await collectInvitationPayment(await f.read(), f.deps);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.cardOnFile).not.toHaveBeenCalled();
    expect(f.collect).not.toHaveBeenCalled();
  });

  it('refuses a missing or no-longer-actionable invitation before payment IO', async () => {
    const f = fixture();
    f.prisma.teamInvite.findUnique.mockResolvedValue(null as never);
    await expect(f.read()).rejects.toMatchObject({ statusCode: 404 });
    expect(f.query).not.toHaveBeenCalled();
  });
});
