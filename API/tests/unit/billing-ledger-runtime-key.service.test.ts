import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import { createLedgerRuntimeKey, revokeLedgerRuntimeKey } from '../../src/services/billing-ledger-runtime-key.service.js';

function store(active = true) {
  const tx = { billingLedgerRuntimeKey: {
    create: vi.fn().mockResolvedValue({ id: 'runtime-1', keyPrefix: 'prefix', createdAt: new Date() }),
    update: vi.fn().mockResolvedValue({ id: 'runtime-1', revokedAt: new Date() }),
  }, adminAuditLog: { create: vi.fn() } };
  const db = { billingService: { findUnique: vi.fn().mockResolvedValue({ id: 'service-1', active }) },
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) };
  return { tx, prisma: db as unknown as PrismaClient };
}
const input = { product: 'nessie', ledgerAudience: 'https://ledger.unlikeotherai.com',
  sourceDomain: ' API.NESSIE.WORKS ', actorEmail: 'operator@example.test' };
it('persists only the digest and exact binding; audit contains no plaintext', async () => {
  const { tx, prisma } = store(); const result = await createLedgerRuntimeKey(input, { prisma });
  expect(result.secret).toMatch(/^uoa_ledger_[A-Za-z0-9_-]{43}$/);
  const data = tx.billingLedgerRuntimeKey.create.mock.calls[0]?.[0].data;
  expect(data.secretDigest).toBe(createHash('sha256').update(result.secret).digest('hex'));
  expect(data).toMatchObject({ serviceId: 'service-1', sourceDomain: 'api.nessie.works',
    ledgerAudience: input.ledgerAudience, createdByEmail: input.actorEmail });
  expect(data.keyPrefix).toBe(result.secret.slice(0, 18));
  expect(JSON.stringify(tx.billingLedgerRuntimeKey.create.mock.calls)).not.toContain(result.secret);
  expect(JSON.stringify(tx.adminAuditLog.create.mock.calls)).not.toContain(result.secret);
  expect(tx.adminAuditLog.create).toHaveBeenCalledWith({ data: { actorEmail: input.actorEmail,
    action: 'billing.ledger_runtime_key_created', metadata: { key_id: 'runtime-1',
      service_id: 'service-1', ledger_audience: input.ledgerAudience,
      source_domain: 'api.nessie.works' } } });
});
it('inactive product cannot mint a key', async () => {
  const { tx, prisma } = store(false);
  await expect(createLedgerRuntimeKey(input, { prisma })).rejects.toThrow('BILLING_SERVICE_NOT_FOUND');
  expect(tx.billingLedgerRuntimeKey.create).not.toHaveBeenCalled();
});
it.each(['http://ledger.example', 'https://ledger.example/', 'https://user:pass@ledger.example'])
('invalid Ledger origin %s cannot persist a key', async (ledgerAudience) => {
  const { tx, prisma } = store();
  await expect(createLedgerRuntimeKey({ ...input, ledgerAudience }, { prisma }))
    .rejects.toThrow('BILLING_LEDGER_AUDIENCE_INVALID');
  expect(tx.billingLedgerRuntimeKey.create).not.toHaveBeenCalled();
});
it('revocation audits only exact ID and actor', async () => {
  const { tx, prisma } = store(); await revokeLedgerRuntimeKey('runtime-1', input.actorEmail, { prisma });
  expect(tx.billingLedgerRuntimeKey.update).toHaveBeenCalledWith({ where: { id: 'runtime-1' },
    data: { revokedAt: expect.any(Date) }, select: { id: true, revokedAt: true } });
  expect(tx.adminAuditLog.create).toHaveBeenCalledWith({ data: { actorEmail: input.actorEmail,
    action: 'billing.ledger_runtime_key_revoked', metadata: { key_id: 'runtime-1' } } });
});
