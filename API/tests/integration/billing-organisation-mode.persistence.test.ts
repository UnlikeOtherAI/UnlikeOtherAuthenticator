import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { resolveOrganisationBillingMode, setOrganisationBillingMode }
  from '../../src/services/billing-organisation-mode.service.js';
import { resolveTeamBillingMode, setTeamBillingMode } from '../../src/services/billing-team-mode.service.js';
import { resolveBillingFundingViewer } from '../../src/services/billing-funding-viewer.service.js';
import { assertBillingPeriodMode } from '../../src/services/billing-mode-period.service.js';
import { resolveBillingFundingRequestRecipients,createBillingCreditFundingRequest }
  from '../../src/services/billing-credit-funding-request.service.js';
import { createRlsTestDb } from '../helpers/test-db.js';
import { assertActiveTeamMembership } from '../../src/services/team-scope.service.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS !== 'true')('organisation financial cutover', () => {
  let db: PrismaClient; let cleanup: () => Promise<void>;
  const actor = { userId: 'org-mode-operator', email: 'org-mode@example.test', tokenVersion: 0 };
  let epoch: string;
  beforeAll(async () => {
    const handle = await createRlsTestDb();
    if (!handle) throw new Error('Disposable DATABASE_URL required');
    db = handle.prisma; cleanup = handle.cleanup;
    await db.user.create({ data: {
      id: actor.userId, email: actor.email, userKey: actor.email,
    } });
    await db.user.create({data:{id:'org-mode-owner',email:'org-mode-owner@example.test',userKey:'org-mode-owner'}});
    await db.domainRole.create({ data: { userId: actor.userId, domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    await db.organisation.create({ data: { id: 'org-mode', domain: 'org-mode.test', name: 'Org mode',
      slug: 'org-mode', ownerId: 'org-mode-owner' } });
    await db.orgMember.create({ data: { orgId: 'org-mode', userId: actor.userId, role: 'member' } });
    await db.orgMember.create({data:{orgId:'org-mode',userId:'org-mode-owner',role:'owner'}});
    await db.team.createMany({ data: ['selected', 'managed'].map((id) => ({
      id, orgId: 'org-mode', name: id, slug: id,
    })) });
    await db.teamMember.createMany({ data: [
      { teamId: 'selected', userId: actor.userId, teamRole: 'member' },
      { teamId: 'managed', userId: actor.userId, teamRole: 'admin' },
    ] });
    await db.billingStripeAccount.createMany({ data: [
      { id: 'org-live', stripeAccountId: 'acct_same_main', livemode: true },
      { id: 'org-test', stripeAccountId: 'acct_same_main', livemode: false },
    ] });
    epoch = (await resolveOrganisationBillingMode('org-mode', db)).epoch;
    await db.$executeRawUnsafe(`CREATE TABLE org_capture_probe(account_id text,org_id text,team_id text,
      billing_mode_team_id text,billing_mode_revision integer,billing_scope_epoch timestamptz)`);
    await db.$executeRawUnsafe(`CREATE TRIGGER org_capture BEFORE INSERT ON org_capture_probe
      FOR EACH ROW EXECUTE FUNCTION guard_billing_effect_mode()`);
  });
  afterAll(async () => { await cleanup?.(); });

  it('defaults the whole organisation to LIVE and one audited selection covers future teams', async () => {
    await expect(resolveOrganisationBillingMode('org-mode', db)).resolves.toEqual({ mode: 'live', revision: 0, epoch });
    await setOrganisationBillingMode({ organisationId: 'org-mode', actor, mode: 'sandbox', expectedRevision: 0 }, db);
    await db.team.create({ data: { id: 'future-team', orgId: 'org-mode', name: 'Future', slug: 'future' } });
    for (const teamId of ['selected', 'managed', 'future-team']) {
      await expect(resolveTeamBillingMode({ organisationId: 'org-mode', teamId }, db))
        .resolves.toEqual({ mode: 'sandbox', revision: 1, epoch });
    }
    expect(await db.adminAuditLog.count({ where: { action: 'billing.organisation_mode_changed' } })).toBe(1);
    await expect(setTeamBillingMode({ organisationId: 'org-mode', teamId: 'selected', actor,
      mode: 'live', expectedRevision: 1 }, db)).rejects.toThrow('BILLING_ORGANISATION_MODE_REQUIRED');
    await expect(db.billingTeamMode.create({ data: { teamId: 'selected', sandbox: true } }))
      .rejects.toThrow('BILLING_MODE_EVIDENCE_IMMUTABLE');
  });
  it('admits an active manager in the same org, never a former or foreign manager', async () => {
    const subject = { organisationId: 'org-mode', teamId: 'selected', userId: actor.userId };
    expect((await resolveBillingFundingViewer(subject, { prisma: db })).billingManager).toBe(true);
    await db.teamMember.update({ where: { teamId_userId: { teamId: 'managed', userId: actor.userId } },
      data: { status: 'REMOVED' } });
    expect((await resolveBillingFundingViewer(subject, { prisma: db })).billingManager).toBe(false);
    await db.teamMember.update({ where: { teamId_userId: { teamId: 'managed', userId: actor.userId } },
      data: { status: 'ACTIVE' } });
    await expect(resolveBillingFundingViewer({ ...subject, organisationId: 'other-org' }, { prisma: db }))
      .rejects.toThrow('BILLING_SUBJECT_NOT_ENTITLED');
  });
  it('requires the immutable org epoch and current mode/revision at capture', async () => {
    const capture = (account: string, revision: number, capturedEpoch: string | null) => db.$executeRaw(Prisma.sql`
      INSERT INTO org_capture_probe VALUES(${account},'org-mode','selected','selected',${revision},${capturedEpoch}::timestamptz)`);
    await expect(capture('org-test', 1, epoch)).resolves.toBe(1);
    await expect(capture('org-live', 1, epoch)).rejects.toThrow('BILLING_ORGANISATION_MODE_CHANGED');
    await expect(capture('org-test', 0, epoch)).rejects.toThrow('BILLING_CONTEXT_STALE');
    await expect(capture('org-test', 1, null)).rejects.toThrow('BILLING_CONTEXT_REQUIRED');
    await expect(capture('org-test', 1, '2020-01-01T00:00:00.000Z')).rejects.toThrow('BILLING_CONTEXT_STALE');
  });
  it('admits an org-only owner without inventing team membership, refusing a team-only manager null branch',async()=>{
    expect((await resolveBillingFundingViewer({organisationId:'org-mode',teamId:null,userId:'org-mode-owner'},
      {prisma:db})).billingManager).toBe(true);
    expect(await db.teamMember.count({where:{userId:'org-mode-owner'}})).toBe(0);
    await expect(resolveBillingFundingViewer({organisationId:'org-mode',teamId:null,userId:actor.userId},
      {prisma:db})).rejects.toThrow('BILLING_MANAGER_REQUIRED');
  });
  it('admits org authority to an exact active same-org team without adding membership',async()=>{
    const subject={organisationId:'org-mode',teamId:'future-team',userId:'org-mode-owner'};
    expect((await resolveBillingFundingViewer(subject,{prisma:db})).billingManager).toBe(true);
    await expect(assertActiveTeamMembership({orgId:subject.organisationId,teamId:subject.teamId,
      userId:subject.userId},{prisma:db})).resolves.toBeUndefined();
    expect(await db.teamMember.count({where:{userId:subject.userId}})).toBe(0);
    await db.user.create({data:{id:'authority-admin',email:'authority-admin@example.test',userKey:'authority-admin'}});
    await db.orgMember.create({data:{orgId:'org-mode',userId:'authority-admin',role:'admin'}});
    const admin={orgId:'org-mode',teamId:'future-team',userId:'authority-admin'};
    await expect(assertActiveTeamMembership(admin,{prisma:db})).resolves.toBeUndefined();
    expect((await resolveBillingFundingViewer({...subject,userId:admin.userId},{prisma:db})).billingManager).toBe(true);
    await db.orgMember.update({where:{orgId_userId:{orgId:admin.orgId,userId:admin.userId}},data:{role:'member'}});
    await expect(assertActiveTeamMembership(admin,{prisma:db})).rejects.toThrow('AUTHENTICATION_FAILED');
    await expect(resolveBillingFundingViewer({...subject,userId:admin.userId},{prisma:db})).rejects.toThrow('BILLING_SUBJECT_NOT_ENTITLED');
    await expect(resolveBillingFundingViewer({...subject,userId:actor.userId},{prisma:db}))
      .rejects.toThrow('BILLING_SUBJECT_NOT_ENTITLED');
    await db.team.update({where:{id:'future-team'},data:{lifecycleStatus:'ARCHIVED'}});
    await expect(resolveBillingFundingViewer(subject,{prisma:db})).rejects.toThrow('BILLING_SUBJECT_NOT_ENTITLED');
  });
  it('keeps member Ask nonfinancial and selects current org managers outside the requester team',async()=>{
    await db.user.createMany({data:['requester','org-admin','other-manager','former-manager'].map(id=>({
      id,email:`${id}@example.test`,userKey:id}))});
    await db.orgMember.createMany({data:['requester','org-admin','other-manager','former-manager'].map(userId=>({
      orgId:'org-mode',userId,role:userId==='org-admin'?'admin':'member'}))});
    await db.teamMember.createMany({data:[{teamId:'selected',userId:'requester',teamRole:'member'},
      {teamId:'managed',userId:'other-manager',teamRole:'owner'},
      {teamId:'managed',userId:'former-manager',teamRole:'admin',status:'REMOVED'}]});
    const recipients=await resolveBillingFundingRequestRecipients({organisationId:'org-mode',teamId:'selected',
      requesterUserId:'requester',organisationPays:true},{prisma:db});
    expect(recipients).toEqual(['org-admin','org-mode-operator','org-mode-owner','other-manager']);
    const before=await db.billingCreditAccount.count();
    const request=await createBillingCreditFundingRequest({request:{product:'nessie',organisationId:'org-mode',
      teamId:'selected',userId:'requester'},actorToken:'verified-by-fixture',credential:{} as never,
      endpoint:'/billing/v1/credits/funding-request'},{prisma:db,resolveEntitlement:async()=>({payload:{tariff:{
        usage_billing_enabled:true,payment_collection_enabled:true}}}) as never});
    expect(request.recipient_user_ids).toEqual(recipients);
    expect(Object.keys(request).sort()).toEqual(['recipient_user_ids','request_id','schema_version']);
    expect(await db.billingCreditAccount.count()).toBe(before);
  });
  it('holds the inclusive installation/change month and keeps evidence immutable', async () => {
    for (const accountId of ['org-live', 'org-test']) {
      await expect(assertBillingPeriodMode(db, { accountId, orgId: 'org-mode', teamId: null,
        month: epoch.slice(0, 7), sourceCreatedAt: new Date('2020-01-01') }))
        .rejects.toThrow('BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED');
    }
    await expect(db.$executeRawUnsafe('UPDATE billing_organisation_scope_cutover SET activated_at=now()'))
      .rejects.toThrow('BILLING_MODE_EVIDENCE_IMMUTABLE');
    await expect(db.$executeRawUnsafe('DELETE FROM billing_organisation_mode_events'))
      .rejects.toThrow('BILLING_MODE_EVIDENCE_IMMUTABLE');
  });
  it('blocks mode changes on untouched legacy funds; never adopts or moves a wallet', async () => {
    await db.billingStripeCustomer.create({ data: { id: 'legacy-customer', accountId: 'org-test',
      orgId: 'org-mode', teamId: 'selected', scope: 'TEAM', scopeKey: 'org-mode:selected' } });
    await db.billingCreditAccount.create({ data: { id: 'legacy-wallet', accountId: 'org-test',
      customerId: 'legacy-customer', orgId: 'org-mode', teamId: 'selected', scopeKey: 'org-mode:selected' } });
    // Synthetic pre-cutover evidence: the application never edits financial rows.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role=replica');
      await tx.billingCreditAccount.update({ where: { id: 'legacy-wallet' }, data: { balanceMicrocredits: 1000000n } });
    });
    const before = await db.billingCreditAccount.findUniqueOrThrow({ where: { id: 'legacy-wallet' } });
    await expect(setOrganisationBillingMode({ organisationId: 'org-mode', actor, mode: 'live', expectedRevision: 1 }, db))
      .rejects.toThrow('BILLING_ORGANISATION_MODE_BLOCKED');
    expect(await db.billingCreditAccount.findUnique({ where: { id: before.id } })).toEqual(before);
  });
});
