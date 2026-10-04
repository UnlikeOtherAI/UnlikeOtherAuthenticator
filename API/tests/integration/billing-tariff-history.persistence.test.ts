import { BillingTariffSource, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  appendTariffTermEvent,
  lockTariffHistoryService,
  resolveBillingTariffForMonth,
} from '../../src/services/billing-tariff-history.service.js';
import { rateProviderCost } from '../../src/services/billing-rating.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let databaseUrl: string;

const serviceId = 'svc_effective_history';
const scope = { serviceId, organisationId: 'org_a', teamId: 'team_a' };

describe.skipIf(!enabled)('effective tariff history with PostgreSQL', () => {
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required');
    prisma = db.prisma;
    cleanup = db.cleanup;
    databaseUrl = db.databaseUrl;
    await prisma.billingService.create({
      data: { id: serviceId, identifier: 'effective-history', name: 'History',
        tariffHistoryFromMonth: '2026-07' },
    });
    for (const [id, mode, markupBps] of [
      ['default', 'STANDARD', 3000],
      ['custom', 'CUSTOM', 1250],
      ['free', 'FREE', 0],
    ] as const) {
      await prisma.billingTariff.create({
        data: { id, serviceId, key: id, version: 1, name: id,
          mode, collectionMode: 'NONE', markupBps, currency: 'USD',
          isDefault: id === 'default' },
      });
    }
    await prisma.billingTariffTermEvent.create({
      data: { serviceId, source: BillingTariffSource.SERVICE_DEFAULT,
        scopeKey: serviceId, effectiveFromMonth: '2026-07', tariffId: 'default',
        reason: 'initial-test' },
    });
  });

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('persists immutable prepaid per-seat terms without changing historical tariff defaults', async () => {
    const historical = await prisma.billingTariff.findUniqueOrThrow({ where: { id: 'default' } });
    expect(historical.monthlyChargeBasis).toBe('FLAT');
    expect(historical.usagePaymentMode).toBe('PAY_AS_YOU_GO');
    const plan = await prisma.billingTariff.create({ data: {
      id: 'prepaid-seat', serviceId, key: 'prepaid-seat', version: 1, name: 'Prepaid seat',
      mode: 'STANDARD', collectionMode: 'STRIPE', markupBps: 3000,
      monthlyAmountMinor: 2500n, monthlyChargeBasis: 'PER_SEAT',
      usagePaymentMode: 'PREPAID', currency: 'USD',
    } });
    expect(plan.monthlyAmountMinor).toBe(2500n);
    expect(plan.monthlyChargeBasis).toBe('PER_SEAT');
    expect(plan.usagePaymentMode).toBe('PREPAID');
  });

  it('keeps old months fixed through future override, removal, and mutable pointer changes', async () => {
    await prisma.$transaction(async (tx) => {
      await lockTariffHistoryService(tx, serviceId);
      await appendTariffTermEvent(tx, {
        serviceId, source: BillingTariffSource.ORGANISATION, scopeKey: 'org_a',
        effectiveFromMonth: '2026-08', tariffId: 'custom', reason: 'negotiated',
      });
      await appendTariffTermEvent(tx, {
        serviceId, source: BillingTariffSource.TEAM, scopeKey: 'org_a:team_a',
        effectiveFromMonth: '2026-09', tariffId: 'free', reason: 'grant',
      });
      await appendTariffTermEvent(tx, {
        serviceId, source: BillingTariffSource.TEAM, scopeKey: 'org_a:team_a',
        effectiveFromMonth: '2026-10', tariffId: null, reason: 'removed',
      });
    });
    await prisma.billingTariff.updateMany({ where: { serviceId }, data: { isDefault: false } });
    await prisma.billingTariff.update({ where: { id: 'custom' }, data: { isDefault: true } });
    for (const [month, expected] of [
      ['2026-07', 'default'], ['2026-08', 'custom'],
      ['2026-09', 'free'], ['2026-10', 'custom'],
    ]) {
      const resolved = await resolveBillingTariffForMonth(prisma, { ...scope, billingMonth: month });
      expect(resolved.tariff.id).toBe(expected);
    }
    const delayed = await resolveBillingTariffForMonth(prisma, { ...scope, billingMonth: '2026-07' });
    expect(rateProviderCost('1.20', 'USD', {
      mode: 'standard', markupBps: delayed.tariff.markupBps,
    }).total).toBe('1.56');
  });

  it('holds unknown historical months and rejects rewriting committed decisions', async () => {
    await expect(resolveBillingTariffForMonth(prisma, {
      ...scope, billingMonth: '2026-06',
    })).rejects.toThrow('BILLING_TARIFF_HISTORY_RECONCILIATION_REQUIRED');
    const event = await prisma.billingTariffTermEvent.findFirstOrThrow({ where: { serviceId } });
    await expect(prisma.billingTariffTermEvent.delete({ where: { id: event.id } }))
      .rejects.toThrow();
  });

  it('serializes simultaneous term decisions before selecting the last committed revision', async () => {
    const second = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    try {
      const first = prisma.$transaction(async (tx) => {
        await lockTariffHistoryService(tx, serviceId);
        signalLocked();
        await firstHeld;
        await appendTariffTermEvent(tx, {
          serviceId, source: BillingTariffSource.ORGANISATION, scopeKey: 'org_a',
          effectiveFromMonth: '2026-11', tariffId: 'default', reason: 'first',
        });
      });
      await locked;
      let secondCommitted = false;
      const later = second.$transaction(async (tx) => {
        await lockTariffHistoryService(tx, serviceId);
        await appendTariffTermEvent(tx, {
          serviceId, source: BillingTariffSource.ORGANISATION, scopeKey: 'org_a',
          effectiveFromMonth: '2026-11', tariffId: 'custom', reason: 'second',
        });
      }).then(() => { secondCommitted = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondCommitted).toBe(false);
      releaseFirst();
      await Promise.all([first, later]);
      const resolved = await resolveBillingTariffForMonth(prisma, {
        ...scope, billingMonth: '2026-11',
      });
      expect(resolved.tariff.id).toBe('custom');
    } finally {
      releaseFirst();
      await second.$disconnect();
    }
  });
});

describe.skipIf(!enabled)('populated tariff-history migration', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL required');
    db = created;
  });

  it('preserves proven existing terms and holds the interval before an audited change', async () => {
    try {
      await db.prisma.$executeRawUnsafe('DROP TABLE "billing_tariff_term_events"');
      await db.prisma.$executeRawUnsafe('DROP FUNCTION reject_billing_tariff_term_event_rewrite()');
      await db.prisma.$executeRawUnsafe(
        'ALTER TABLE "billing_services" DROP COLUMN "tariff_history_from_month"',
      );
      await db.prisma.$executeRawUnsafe(`
        INSERT INTO "billing_services" ("id", "identifier", "name", "created_at", "updated_at")
        VALUES
          ('old-stable', 'old-stable', 'Stable', '2026-05-10', '2026-05-10'),
          ('old-changed', 'old-changed', 'Changed', '2026-05-10', '2026-08-09'),
          ('old-ambiguous', 'old-ambiguous', 'Ambiguous', '2026-05-10', '2026-06-09')
      `);
      await db.prisma.$executeRawUnsafe(`
        INSERT INTO "billing_tariffs" ("id", "service_id", "key", "version", "name",
          "mode", "collection_mode", "markup_bps", "currency", "is_default", "created_at")
        VALUES
          ('old-stable-tariff', 'old-stable', 'standard', 1, 'Grandfathered',
            'STANDARD', 'NONE', 1250, 'USD', true, '2026-05-10'),
          ('old-changed-tariff', 'old-changed', 'custom', 2, 'Negotiated',
            'CUSTOM', 'NONE', 1750, 'USD', true, '2026-08-09'),
          ('old-ambiguous-first', 'old-ambiguous', 'standard', 1, 'First',
            'STANDARD', 'NONE', 1250, 'USD', false, '2026-05-10'),
          ('old-ambiguous-current', 'old-ambiguous', 'standard', 2, 'Current',
            'STANDARD', 'NONE', 3000, 'USD', true, '2026-06-09')
      `);
      await db.prisma.$executeRawUnsafe(`
        INSERT INTO "admin_audit_log" ("id", "actor_email", "action", "metadata", "created_at")
        VALUES ('audit-change', 'operator@example.test', 'billing.default_tariff_changed',
          '{"service_id":"old-changed","tariff_id":"old-changed-tariff"}'::jsonb,
          '2026-08-09')
      `);
      const here = path.dirname(fileURLToPath(import.meta.url));
      const migration = path.resolve(here,
        '../../prisma/migrations/20261004130000_add_effective_tariff_history/migration.sql');
      const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
      execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--schema',
        'prisma/schema.prisma', '--file', migration], {
        cwd: path.resolve(here, '../..'),
        env: { ...process.env, DATABASE_URL: db.databaseUrl },
        stdio: 'pipe',
      });
      const conservativeCutoff = path.resolve(here,
        '../../prisma/migrations/20261004130200_conservative_legacy_tariff_cutoff/migration.sql');
      execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--schema',
        'prisma/schema.prisma', '--file', conservativeCutoff], {
        cwd: path.resolve(here, '../..'),
        env: { ...process.env, DATABASE_URL: db.databaseUrl },
        stdio: 'pipe',
      });
      const stable = await db.prisma.billingService.findUniqueOrThrow({ where: { id: 'old-stable' } });
      const changed = await db.prisma.billingService.findUniqueOrThrow({ where: { id: 'old-changed' } });
      expect(stable.tariffHistoryFromMonth).toBe('2026-05');
      expect(changed.tariffHistoryFromMonth).toBe('2026-09');
      const ambiguous = await db.prisma.billingService.findUniqueOrThrow({
        where: { id: 'old-ambiguous' },
      });
      expect(ambiguous.tariffHistoryFromMonth > '2026-06').toBe(true);
      await expect(resolveBillingTariffForMonth(db.prisma, {
        serviceId: 'old-ambiguous', organisationId: 'org', teamId: 'team',
        billingMonth: '2026-06',
      })).rejects.toThrow('BILLING_TARIFF_HISTORY_RECONCILIATION_REQUIRED');
      const stableTerm = await resolveBillingTariffForMonth(db.prisma, {
        serviceId: 'old-stable', organisationId: 'org', teamId: 'team', billingMonth: '2026-06',
      });
      expect(stableTerm.tariff.markupBps).toBe(1250);
      await expect(resolveBillingTariffForMonth(db.prisma, {
        serviceId: 'old-changed', organisationId: 'org', teamId: 'team', billingMonth: '2026-08',
      })).rejects.toThrow('BILLING_TARIFF_HISTORY_RECONCILIATION_REQUIRED');
      const later = await resolveBillingTariffForMonth(db.prisma, {
        serviceId: 'old-changed', organisationId: 'org', teamId: 'team', billingMonth: '2026-09',
      });
      expect(later.tariff.markupBps).toBe(1750);
    } finally {
      await db.cleanup();
    }
  });
});
