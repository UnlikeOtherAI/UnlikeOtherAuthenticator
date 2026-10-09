import { expect, it, vi } from 'vitest';
import { listSmsRecoveryLiabilities } from '../../src/services/billing-sms-liability-admin.service.js';
const db = vi.hoisted(() => ({ billingSmsInboundReceipt: { findMany: vi.fn() }, billingSmsReservation: { findMany: vi.fn() } }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => db }));
const binding = { id: 'receipt-1', serviceId: 'nessie', numberId: 'resource-1', allocationId: 'allocation-1',
  accountSid: 'AC_fixture', messageSid: 'SM_fixture', orgId: 'org-1', teamId: 'team-1',
  state: 'uncollected', createdAt: new Date('2026-10-08'), updatedAt: new Date('2026-10-08') };
it('shows exact frozen inbound binding and customer liability credits, keeping unknown distinct from zero and provider cost private', async () => {
  db.billingSmsInboundReceipt.findMany.mockResolvedValue([{ ...binding, standingHoldId: null,
    consumedMicrocredits: 0n, uncollectedMicrocredits: 1234567n, actualAmount: 'secret-provider-cost', actualCurrency: 'USD' }]);
  const result = await listSmsRecoveryLiabilities('inbound');
  expect(result.liabilities[0]).toMatchObject({ consumed_credits: '0', uncollected_credits: '1.234567',
    number_id: 'resource-1', allocation_id: 'allocation-1', team_id: 'team-1' });
  expect(JSON.stringify(result)).not.toContain('secret-provider-cost'); expect(JSON.stringify(result)).not.toContain('actualCurrency');
});
it('retains exact held credits for uncertain outbound and exposes no provider cost or mutation', async () => {
  db.billingSmsReservation.findMany.mockResolvedValue([{ ...binding, state: 'uncertain', messageSid: null,
    dispatchId: 'dispatch-1', reservedMicrocredits: 10_000_001n, debitedMicrocredits: null, actualAmount: 'secret' }]);
  const result = await listSmsRecoveryLiabilities('outbound', 'prior');
  expect(result.liabilities[0]).toMatchObject({ reserved_credits: '10.000001', consumed_credits: null,
    uncollected_credits: null, state: 'uncertain', dispatch_id: 'dispatch-1' });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(db.billingSmsReservation.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: 'prior' },
    where: { state: { in: ['dispatching', 'uncertain', 'reconciliation'] } } }));
});
