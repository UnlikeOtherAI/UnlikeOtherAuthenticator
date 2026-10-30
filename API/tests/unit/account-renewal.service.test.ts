import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFind: vi.fn(), userUpdate: vi.fn(), requestFind: vi.fn(), requestUpsert: vi.fn(), requestUpdate: vi.fn(),
  requestUpdateMany: vi.fn(), roles: vi.fn(), query: vi.fn(), email: vi.fn(), audit: vi.fn(),
}));
const prisma = {
  user: { findUnique: mocks.userFind, update: mocks.userUpdate },
  accountRenewalRequest: { findUnique: mocks.requestFind, upsert: mocks.requestUpsert,
    update: mocks.requestUpdate, updateMany: mocks.requestUpdateMany },
  domainRole: { findMany: mocks.roles },
  $queryRaw: mocks.query,
};
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => prisma }));
vi.mock('../../src/db/tenant-context.js', () => ({ runInTransaction: async (_db: unknown, callback: (db: typeof prisma) => Promise<unknown>) => callback(prisma) }));
vi.mock('../../src/config/env.js', () => ({ getAdminAuthDomain: () => 'authentication.unlikeotherai.com',
  getEnv: () => ({ PUBLIC_BASE_URL: 'https://authentication.unlikeotherai.com', EMAIL_FROM: 'admin@example.com' }) }));
vi.mock('../../src/services/email.service.js', () => ({ sendRawEmail: mocks.email }));
vi.mock('../../src/services/audit-log.service.js', () => ({ writeAuditLog: mocks.audit }));

describe('expired account renewal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue([{ id: 'request-1' }]);
    mocks.email.mockResolvedValue(undefined);
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.audit.mockResolvedValue(undefined);
  });

  it('answers unknown and current accounts identically without notifying admins', async () => {
    const { requestAccountRenewal } = await import('../../src/services/account-renewal.service.js');
    mocks.userFind.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'user-1', lifecycleStatus: 'ACTIVE',
      accountExpiresAt: new Date(Date.now() + 60000) });
    await expect(requestAccountRenewal('unknown-user')).resolves.toEqual({ ok: true });
    await expect(requestAccountRenewal('current-user')).resolves.toEqual({ ok: true });
    expect(mocks.requestUpsert).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
  });

  it('records one pending request and emails an active platform admin with the review page', async () => {
    const { requestAccountRenewal } = await import('../../src/services/account-renewal.service.js');
    const expired = { id: 'user-1', email: 'expired@example.com', lifecycleStatus: 'ACTIVE',
      accountExpiresAt: new Date(Date.now() - 60000) };
    mocks.userFind.mockResolvedValue(expired);
    mocks.requestFind.mockResolvedValue(null);
    mocks.requestUpsert.mockResolvedValue({ id: 'request-1' });
    mocks.roles.mockResolvedValue([{ user: { email: 'admin@example.com', accountExpiresAt: null } }]);
    await expect(requestAccountRenewal(expired.id)).resolves.toEqual({ ok: true });
    expect(mocks.requestUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@example.com',
      text: expect.stringContaining('/admin/users/user-1?tab=security') }));
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: {
      notifiedAt: expect.any(Date) } }));
  });

  it('approval atomically sets a future date, records the decision and keeps the password', async () => {
    const { reviewAccountRenewal } = await import('../../src/services/account-renewal.service.js');
    mocks.requestFind.mockResolvedValue({ id: 'request-1', userId: 'user-1', status: 'PENDING',
      user: { id: 'user-1', email: 'expired@example.com', lifecycleStatus: 'ACTIVE',
        accountExpiresAt: new Date(Date.now() - 60000) } });
    const date = new Date(Date.now() + 86400000).toISOString();
    await expect(reviewAccountRenewal({ requestId: 'request-1', actorUserId: 'admin-1',
      actorEmail: 'admin@example.com', decision: 'approve', accountExpiresAt: date })).resolves.toEqual({
      userId: 'user-1', status: 'approved', accountExpiresAt: date,
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { accountExpiresAt: new Date(date) } });
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'APPROVED', reviewedByUserId: 'admin-1' }) }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.account_renewal_approved' }),
      expect.anything());
  });

  it('decline records the reviewer without changing the expired account', async () => {
    const { reviewAccountRenewal } = await import('../../src/services/account-renewal.service.js');
    mocks.requestFind.mockResolvedValue({ id: 'request-1', userId: 'user-1', status: 'PENDING',
      user: { id: 'user-1', email: 'expired@example.com', lifecycleStatus: 'ACTIVE',
        accountExpiresAt: new Date(Date.now() - 60000) } });
    await expect(reviewAccountRenewal({ requestId: 'request-1', actorUserId: 'admin-1',
      actorEmail: 'admin@example.com', decision: 'decline' })).resolves.toEqual({
      userId: 'user-1', status: 'declined', accountExpiresAt: null,
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'DECLINED', reviewedByUserId: 'admin-1' }) }));
  });
});
