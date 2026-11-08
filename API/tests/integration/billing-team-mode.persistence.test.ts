import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { assertOrganisationBillingMode, readTeamBillingMode, resolveTeamBillingMode }
  from '../../src/services/billing-team-mode.service.js';
import { setOrganisationBillingMode } from '../../src/services/billing-organisation-mode.service.js';
import { createRlsTestDb } from '../helpers/test-db.js';
import { assertBillingPeriodMode } from '../../src/services/billing-mode-period.service.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS !== 'true')('organisation mode inherited by selected teams', () => {
  let db: PrismaClient;
  let appDb: PrismaClient;
  let cleanup: () => Promise<void>; let epoch:string;
  const subject = { organisationId: 'mode-org', teamId: 'mode-team' };
  const actor = { userId: 'mode-admin', email: 'mode-admin@example.test', tokenVersion: 0 };
  beforeAll(async () => {
    const handle = await createRlsTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for billing mode persistence tests');
    db = handle.prisma; cleanup = handle.cleanup;
    appDb = new PrismaClient({ datasources: { db: { url: handle.appDatabaseUrl } } });
    await db.user.create({ data: { id: actor.userId, email: actor.email, userKey: actor.email } });
    await db.domainRole.create({ data: { userId: actor.userId, domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    await db.organisation.create({ data: { id: subject.organisationId, domain: 'mode.example.test',
      name: 'Mode organisation', slug: 'billing-mode-proof', ownerId: actor.userId } });
    await db.team.createMany({ data: [
      { id: subject.teamId, orgId: subject.organisationId, name: 'Selected team', slug: 'selected-team' },
      { id: 'mode-sibling', orgId: subject.organisationId, name: 'Other team', slug: 'other-team' },
    ] });
    await db.billingStripeAccount.createMany({ data: [
      { id: 'mode-live', stripeAccountId: 'acct_main', livemode: true },
      { id: 'mode-test', stripeAccountId: 'acct_main', livemode: false },
    ] });
    epoch=(await db.billingOrganisationScopeCutover.findUniqueOrThrow({where:{id:1}})).activatedAt.toISOString();
    // Exercise the actual capture guard independently from unrelated financial constraints.
    await db.$executeRawUnsafe(`CREATE TABLE mode_capture_probe(account_id text, org_id text,
      team_id text, billing_mode_team_id text, billing_mode_revision integer,billing_scope_epoch timestamptz)`);
    await db.$executeRawUnsafe(`CREATE TRIGGER mode_capture_guard BEFORE INSERT ON mode_capture_probe
      FOR EACH ROW EXECUTE FUNCTION guard_billing_effect_mode()`);
    await db.$executeRawUnsafe(`CREATE TRIGGER mode_capture_immutable BEFORE UPDATE ON mode_capture_probe
      FOR EACH ROW EXECUTE FUNCTION guard_billing_captured_mode()`);
  });
  afterAll(async () => { await appDb?.$disconnect(); await cleanup?.(); });

  it('defaults to LIVE and audits one organisation-wide setting inherited by every team', async () => {
    await expect(resolveTeamBillingMode(subject, db)).resolves.toMatchObject({ mode: 'live', revision: 0 });
    const changed = await setOrganisationBillingMode({ ...subject, actor, mode: 'sandbox', expectedRevision: 0 }, db);
    expect(changed).toMatchObject({ mode: 'sandbox', revision: 1, blockers: [] });
    await expect(resolveTeamBillingMode({ ...subject, teamId: 'mode-sibling' }, db))
      .resolves.toMatchObject({ mode: 'sandbox', revision: 1 });
    expect(await db.adminAuditLog.count({ where: { action: 'billing.organisation_mode_changed' } })).toBe(1);
    await expect(setOrganisationBillingMode({ ...subject, actor, mode: 'sandbox', expectedRevision: 1 }, db))
      .resolves.toMatchObject({ revision: 1 });
    expect(await db.adminAuditLog.count({ where: { action: 'billing.organisation_mode_changed' } })).toBe(1);
  });
  it('refuses mixed organisation money, stale edits, removed authority and foreign teams', async () => {
    await expect(assertOrganisationBillingMode(subject.organisationId, true, db))
      .rejects.toThrow('BILLING_ORGANISATION_MODE_CHANGED');
    await expect(setOrganisationBillingMode({ ...subject, actor, mode: 'live', expectedRevision: 0 }, db))
      .rejects.toThrow('BILLING_ORGANISATION_MODE_CHANGED');
    await expect(setOrganisationBillingMode({ ...subject, actor: { ...actor, tokenVersion: 1 },
      mode: 'live', expectedRevision: 1 }, db)).rejects.toThrow('BILLING_ADMIN_AUTHORITY_REQUIRED');
    await expect(resolveTeamBillingMode({ ...subject, organisationId: 'another-org' }, db))
      .rejects.toThrow('BILLING_TEAM_NOT_AVAILABLE');
  });
  it('captures the exact account/mode/revision and refuses stale or unbound money', async () => {
    const insert = (account: string, revision: number, modeTeam: string | null = subject.teamId,scopeEpoch:string|null=epoch) =>
      db.$executeRaw(Prisma.sql`INSERT INTO mode_capture_probe VALUES (${account},
        ${subject.organisationId}, ${subject.teamId}, ${modeTeam}, ${revision},${scopeEpoch}::timestamptz)`);
    await expect(insert('mode-test', 1)).resolves.toBe(1);
    await expect(insert('mode-live', 1)).rejects.toThrow('BILLING_ORGANISATION_MODE_CHANGED');
    await expect(insert('mode-test', 0)).rejects.toThrow('BILLING_CONTEXT_STALE');
    await expect(insert('mode-test', 0, null,null)).rejects.toThrow('BILLING_CONTEXT_REQUIRED');
    await expect(db.$executeRawUnsafe('UPDATE mode_capture_probe SET billing_mode_revision = 0'))
      .rejects.toThrow('BILLING_MODE_EVIDENCE_IMMUTABLE');
    await expect(db.billingOrganisationMode.delete({ where: { orgId: subject.organisationId } }))
      .rejects.toThrow('BILLING_MODE_EVIDENCE_IMMUTABLE');
  });
  it('denies ordinary runtime policy writes and preserves the operator choice', async () => {
    await expect(appDb.billingOrganisationMode.update({ where: { orgId: subject.organisationId }, data: { sandbox: false } }))
      .rejects.toThrow();
    await expect(readTeamBillingMode(subject, db)).resolves.toMatchObject({ mode: 'sandbox', revision: 1 });
  });
  it('keeps immutable cutover/history and refuses cumulative totals across a mode transition', async () => {
    const epoch = await db.billingOrganisationScopeCutover.findUniqueOrThrow({ where: { id: 1 } });
    const month = epoch.activatedAt.toISOString().slice(0, 7);
    await expect(db.billingOrganisationScopeCutover.update({ where: { id: 1 }, data: { activatedAt: new Date(0) } }))
      .rejects.toThrow('BILLING_MODE_EVIDENCE_IMMUTABLE');
    expect(await db.billingOrganisationModeEvent.count({ where: { orgId: subject.organisationId } })).toBe(1);
    await expect(db.billingOrganisationModeEvent.deleteMany()).rejects.toThrow('BILLING_MODE_EVIDENCE_IMMUTABLE');
    for (const accountId of ['mode-test', 'mode-live']) {
      await expect(assertBillingPeriodMode(db, { accountId, orgId: subject.organisationId,
        teamId: subject.teamId, month, sourceCreatedAt: new Date('2020-01-01') }))
        .rejects.toThrow('BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED');
    }
    const future = new Date(Date.UTC(epoch.activatedAt.getUTCFullYear(), epoch.activatedAt.getUTCMonth() + 1, 1))
      .toISOString().slice(0, 7);
    await expect(assertBillingPeriodMode(db, { accountId: 'mode-test', orgId: subject.organisationId,
      teamId: subject.teamId, month: future, sourceCreatedAt: epoch.activatedAt })).resolves.toBeUndefined();
    await expect(assertBillingPeriodMode(db, { accountId: 'mode-live', orgId: subject.organisationId,
      teamId: subject.teamId, month: future, sourceCreatedAt: epoch.activatedAt }))
      .rejects.toThrow('BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
    await expect(assertBillingPeriodMode(db, { accountId: 'mode-live', orgId: subject.organisationId,
      teamId: 'mode-sibling', month: future, sourceCreatedAt: epoch.activatedAt }))
      .rejects.toThrow('BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH');
  });
});
