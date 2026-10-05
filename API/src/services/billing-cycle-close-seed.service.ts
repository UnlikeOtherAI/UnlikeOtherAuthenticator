import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';

type Kind = 'stripe' | 'manual' | 'team_discovery';
type Source = { sourceId: string; serviceId: string; orgId: string;
  teamId: string | null; startsAt: Date; endsAt: Date | null;
  effectiveFromMonth?: string | null; nextEffectiveMonth?: string | null };
const HISTORICAL_SOURCE_BATCH = 80;

function monthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function monthKey(value: Date): string {
  return value.toISOString().slice(0, 7);
}

function previousMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

/** Recent closed periods bypass historical cursor position after a restart. */
export async function seedRecentBillingCycleWatches(
  deps?: { prisma?: PrismaClient; now?: Date },
): Promise<number> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now ?? new Date();
  const recent = previousMonth(now);
  const older = new Date(Date.UTC(recent.getUTCFullYear(), recent.getUTCMonth() - 1, 1));
  const rows = await prisma.$queryRaw<Array<{ inserted: bigint }>>(Prisma.sql`
    WITH months AS (
      SELECT ${monthKey(recent)}::char(7) AS month, ${recent}::timestamptz AS starts_at, 0 AS priority
      UNION ALL
      SELECT ${monthKey(older)}::char(7), ${older}::timestamptz, 1
    ), sources AS (
      SELECT 'stripe'::varchar(24) AS kind, subscription.id AS source_id,
        subscription.service_id, subscription.org_id, subscription.team_id,
        COALESCE(subscription.billable_from, subscription.created_at) AS starts_at,
        subscription.billable_until AS ends_at, NULL::char(7) AS next_month
      FROM billing_stripe_subscriptions AS subscription
      UNION ALL
      SELECT 'manual', term.id, term.service_id, contract.org_id, NULL::text,
        contract.activated_at, contract.terminated_at,
        (SELECT min(later.effective_from_month)
         FROM billing_organisation_contract_versions AS later
         WHERE later.contract_id = version.contract_id
           AND later.effective_from_month > version.effective_from_month)
      FROM billing_contract_service_terms AS term
      JOIN billing_organisation_contract_versions AS version ON version.id = term.contract_version_id
      JOIN billing_organisation_contracts AS contract ON contract.id = version.contract_id
      WHERE contract.activated_at IS NOT NULL
      UNION ALL
      SELECT 'team_discovery', service.id || ':' || org.id, service.id, org.id,
        NULL::text, GREATEST(org.created_at, LEAST(service.created_at,
          CASE WHEN service.tariff_history_from_month = '9999-12'
            THEN service.created_at ELSE
              ((service.tariff_history_from_month || '-01')::date::timestamp AT TIME ZONE 'UTC')
          END)),
        NULL::timestamptz, NULL::char(7)
      FROM billing_services AS service CROSS JOIN organisations AS org
    ), inserted AS (
      INSERT INTO billing_cycle_close_watches (
        id, source_kind, source_id, service_id, org_id, team_id, billing_month,
        priority, next_check_at
      )
      SELECT gen_random_uuid()::text, source.kind, source.source_id,
        source.service_id, source.org_id, source.team_id, month.month,
        month.priority, ${now}::timestamptz
      FROM sources AS source CROSS JOIN months AS month
      WHERE source.starts_at < month.starts_at + interval '1 month'
        AND (source.ends_at IS NULL OR source.ends_at > month.starts_at)
        AND (source.kind <> 'manual' OR EXISTS (
          SELECT 1 FROM billing_contract_service_terms AS term
          JOIN billing_organisation_contract_versions AS version
            ON version.id = term.contract_version_id
          WHERE term.id = source.source_id AND version.effective_from_month <= month.month
        ))
        AND (source.next_month IS NULL OR source.next_month > month.month)
      ON CONFLICT (source_kind, source_id, billing_month) DO NOTHING
      RETURNING id
    )
    SELECT count(*)::bigint AS inserted FROM inserted
  `);
  return Number(rows[0]?.inserted ?? 0n);
}

async function sourcesAfter(prisma: PrismaClient, kind: Kind,
  after: string): Promise<Source[]> {
  if (kind === 'stripe') {
    return prisma.$queryRaw<Source[]>(Prisma.sql`
      SELECT id AS "sourceId", service_id AS "serviceId", org_id AS "orgId",
        team_id AS "teamId", COALESCE(billable_from, created_at) AS "startsAt",
        billable_until AS "endsAt"
      FROM billing_stripe_subscriptions
      WHERE id COLLATE "C" > ${after} COLLATE "C"
      ORDER BY id COLLATE "C" LIMIT ${HISTORICAL_SOURCE_BATCH}
    `);
  }
  if (kind === 'manual') {
    return prisma.$queryRaw<Source[]>(Prisma.sql`
      SELECT term.id AS "sourceId", term.service_id AS "serviceId",
        contract.org_id AS "orgId", NULL::text AS "teamId",
        contract.activated_at AS "startsAt", contract.terminated_at AS "endsAt",
        version.effective_from_month AS "effectiveFromMonth",
        (SELECT min(later.effective_from_month)
         FROM billing_organisation_contract_versions AS later
         WHERE later.contract_id = version.contract_id
           AND later.effective_from_month > version.effective_from_month)
          AS "nextEffectiveMonth"
      FROM billing_contract_service_terms AS term
      JOIN billing_organisation_contract_versions AS version ON version.id = term.contract_version_id
      JOIN billing_organisation_contracts AS contract ON contract.id = version.contract_id
      WHERE term.id COLLATE "C" > ${after} COLLATE "C"
        AND contract.activated_at IS NOT NULL
      ORDER BY term.id COLLATE "C" LIMIT ${HISTORICAL_SOURCE_BATCH}
    `);
  }
  return prisma.$queryRaw<Source[]>(Prisma.sql`
    SELECT service.id || ':' || org.id AS "sourceId", service.id AS "serviceId",
      org.id AS "orgId", NULL::text AS "teamId",
      GREATEST(org.created_at, LEAST(service.created_at,
        CASE WHEN service.tariff_history_from_month = '9999-12'
          THEN service.created_at ELSE
            ((service.tariff_history_from_month || '-01')::date::timestamp AT TIME ZONE 'UTC')
        END))
        AS "startsAt", NULL::timestamptz AS "endsAt"
    FROM billing_services AS service CROSS JOIN organisations AS org
    WHERE (service.id || ':' || org.id) COLLATE "C" > ${after} COLLATE "C"
    ORDER BY (service.id || ':' || org.id) COLLATE "C"
    LIMIT ${HISTORICAL_SOURCE_BATCH}
  `);
}

function closedMonths(source: Source, kind: Kind, now: Date): string[] {
  const last = previousMonth(now);
  const first = source.effectiveFromMonth && source.effectiveFromMonth > monthKey(source.startsAt) ?
    new Date(`${source.effectiveFromMonth}-01T00:00:00.000Z`) : monthStart(source.startsAt);
  const months: string[] = [];
  for (let value = first; value <= last;
    value = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1))) {
    const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
    if (kind === 'manual' && source.nextEffectiveMonth &&
      monthKey(value) >= source.nextEffectiveMonth) break;
    if (source.endsAt && source.endsAt <= value) break;
    if (source.startsAt < end) months.push(monthKey(value));
  }
  return months;
}

/** Advances one persisted keyset for each source family, independent of process lifetime. */
export async function seedHistoricalBillingCycleWatches(
  kind: Kind, deps?: { prisma?: PrismaClient; now?: Date },
): Promise<{ sources: number; inserted: number; wrapped: boolean }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    // A first run on two instances must have one progress row to lock before
    // either worker reads and advances its persisted keyset.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO billing_cycle_seed_progress (kind) VALUES (${kind})
      ON CONFLICT (kind) DO NOTHING
    `);
    const rows = await tx.$queryRaw<Array<{ kind: string; lastKey: string }>>(Prisma.sql`
      SELECT kind, last_key AS "lastKey" FROM billing_cycle_seed_progress
      WHERE kind = ${kind} FOR UPDATE
    `);
    const lastKey = rows[0]?.lastKey ?? '';
    const sources = await sourcesAfter(tx as unknown as PrismaClient, kind, lastKey);
    if (sources.length === 0) {
      await tx.billingCycleSeedProgress.update({ where: { kind }, data: { lastKey: '' } });
      return { sources: 0, inserted: 0, wrapped: true };
    }
    const created = await tx.billingCycleCloseWatch.createMany({ data: sources.flatMap((source) =>
      closedMonths(source, kind, now).map((billingMonth) => ({
        sourceKind: kind, sourceId: source.sourceId, serviceId: source.serviceId,
        orgId: source.orgId, teamId: source.teamId, billingMonth,
        priority: billingMonth === monthKey(previousMonth(now)) ? 0 : 1,
        nextCheckAt: now,
      }))), skipDuplicates: true });
    await tx.billingCycleSeedProgress.update({ where: { kind }, data: {
      lastKey: sources.at(-1)?.sourceId ?? lastKey,
    } });
    return { sources: sources.length, inserted: created.count, wrapped: false };
  });
}
