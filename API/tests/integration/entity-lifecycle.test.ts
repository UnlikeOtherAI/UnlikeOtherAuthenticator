import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { assertEntityAccess, historicalIdentity } from '../../src/services/entity-lifecycle.service.js';
import { getEntityLifecycle, saveLifecycleTemplate, setEntityLifecycle } from '../../src/services/internal-admin-lifecycle.service.js';
import { acknowledgeProductDeletion, beginEntityDeletion, executeEntityDeletion, getDeletionPreview, productDeletionJobs } from '../../src/services/entity-deletion-job.service.js';
import { scrubIdentityJson } from '../../src/services/identity-audit-sweep.service.js';
import { startLifecycleStatus, verifyLifecycleStatus } from '../../src/services/lifecycle-status.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { hasTeamCapability } from '../../src/services/team.service.base.js';
import type { OrgServicePrisma } from '../../src/services/organisation.service.base.js';

const store = vi.hoisted(() => ({ prisma: null as PrismaClient | null, mail: vi.fn() }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => store.prisma!, getPrisma: () => store.prisma! }));
vi.mock('../../src/services/email.service.js', () => ({ sendActionVerificationEmail: store.mail }));
const domain = 'lifecycle.example.com';

describe.skipIf(!process.env.DATABASE_URL)('entity lifecycle on PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const original = process.env.DATABASE_URL;
  beforeAll(async () => {
    handle = (await createTestDb())!;
    store.prisma = handle.prisma;
    process.env.DATABASE_URL = handle.databaseUrl;
  });
  afterAll(async () => {
    process.env.DATABASE_URL = original;
    await handle?.cleanup();
  });
  beforeEach(async () => {
    await handle.prisma.$executeRawUnsafe('TRUNCATE users, organisations, client_domains, entity_deletion_jobs, lifecycle_reason_templates, admin_audit_log, org_audit_log CASCADE');
    store.mail.mockReset().mockResolvedValue(undefined);
  });
  const user = (name = 'Person') => handle.prisma.user.create({ data: { name, email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
  async function actor() {
    const admin = await user('Administrator');
    await handle.prisma.domainRole.create({ data: { userId: admin.id, domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    return { userId: admin.id, tokenVersion: admin.tokenVersion };
  }
  async function container() {
    const owner = await user('Owner');
    const org = await handle.prisma.organisation.create({ data: { name: 'Company', slug: randomUUID(), domain, ownerId: owner.id } });
    const team = await handle.prisma.team.create({ data: { orgId: org.id, name: 'Workspace', slug: randomUUID(), isDefault: true } });
    await handle.prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
    await handle.prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id } });
    await handle.prisma.clientDomain.create({ data: { domain, label: "Product" } });
    return { owner, org, team };
  }
  async function start(scope: 'USER' | 'TEAM' | 'ORGANISATION', id: string, admin: Awaited<ReturnType<typeof actor>>, mode: 'RETAIN_REFERENCE' | 'ERASE_REFERENCE' = 'RETAIN_REFERENCE') {
    const preview = await getDeletionPreview(scope, id, mode);
    return beginEntityDeletion({ scope, id, mode, actor: admin, previewDigest: preview.digest, confirmation: preview.confirmation, requestKey: randomUUID() });
  }
  async function acknowledge(job: Awaited<ReturnType<typeof start>>) {
    for (const p of job.participants) await acknowledgeProductDeletion({ clientDomainId: p.clientDomainId, jobId: job.id, revision: job.revision, outcome: 'PURGED' });
  }

  it('inherits parent denial without overwriting a separately disabled child or membership', async () => {
    const admin = await actor(), { owner, org, team } = await container();
    const reason = await saveLifecycleTemplate({ scope: 'ORGANISATION', title: 'Review', message: 'Please contact support.', enabled: true, actor: admin });
    await handle.prisma.team.update({ where: { id: team.id }, data: { lifecycleStatus: 'DISABLED' } });
    await setEntityLifecycle({ scope: 'ORGANISATION', id: org.id, status: 'DISABLED', templateId: reason.id, templateRevision: reason.revision, internalNote: 'Private investigation', actor: admin });
    await expect(assertEntityAccess({ userId: owner.id, teamId: team.id }, handle.prisma)).rejects.toThrow('ACCESS_DENIED');
    expect((await handle.prisma.teamMember.findFirstOrThrow()).status).toBe('ACTIVE');
    await setEntityLifecycle({ scope: 'ORGANISATION', id: org.id, status: 'ACTIVE', actor: admin });
    expect((await handle.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).lifecycleStatus).toBe('DISABLED');
  });
  it('protects the last active platform administrator and rejects stale actor epochs', async () => {
    const admin = await actor();
    await expect(setEntityLifecycle({ scope: 'USER', id: admin.userId, status: 'DISABLED', actor: admin })).rejects.toThrow('LAST_ACTIVE_PLATFORM_ADMIN');
    await handle.prisma.user.update({ where: { id: admin.userId }, data: { tokenVersion: { increment: 1 } } });
    await expect(start('USER', (await user()).id, admin)).rejects.toThrow('FORBIDDEN');
  });
  it('snapshots the chosen template revision and rejects stale selections', async () => {
    const admin = await actor(), target = await user();
    const first = await saveLifecycleTemplate({ scope: 'USER', title: 'Review', message: 'First reason', enabled: true, actor: admin });
    await setEntityLifecycle({ scope: 'USER', id: target.id, status: 'DISABLED', templateId: first.id, templateRevision: 1, actor: admin });
    await saveLifecycleTemplate({ id: first.id, scope: 'USER', title: 'Review', message: 'Updated reason', enabled: true, actor: admin });
    expect((await getEntityLifecycle('USER', target.id)).reason).toBe('First reason');
    await expect(setEntityLifecycle({ scope: 'USER', id: target.id, status: 'DISABLED', templateId: first.id, templateRevision: 1, actor: admin })).rejects.toThrow('LIFECYCLE_TEMPLATE_CHANGED');
  });
  it('erases PII while retaining a terminal historical subject and permits a fresh registration identity', async () => {
    const admin = await actor(), target = await user('Al');
    await handle.prisma.domainRole.create({ data: { userId: target.id, domain } });
    await handle.prisma.clientDomain.create({ data: { domain, label: "Product" } });
    await handle.prisma.loginLog.create({ data: { userId: target.id, email: target.email!, domain, authMethod: 'email', ip: '192.0.2.1' } });
    await handle.prisma.adminAuditLog.create({ data: { actorEmail: 'other@example.com', action: 'operation', metadata: { userId: target.id, name: 'Al', email: target.email, unrelated: 'All systems are available' } } });
    const job = await start('USER', target.id, admin);
    await acknowledge(job); await executeEntityDeletion(job.id, admin);
    const tombstone = await handle.prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(tombstone).toMatchObject({ email: null, userKey: null, name: null, passwordHash: null, lifecycleStatus: 'DELETED' });
    expect(historicalIdentity(tombstone)).toEqual({ id: target.id, deleted: true, name: 'Deleted user' });
    expect(await handle.prisma.loginLog.count()).toBe(0);
    expect(await handle.prisma.historicalIdentityReference.count({ where: { userId: target.id, domain } })).toBe(1);
    await expect(handle.prisma.domainRole.create({ data: { userId: target.id, domain } })).rejects.toThrow();
    const replacement = await handle.prisma.user.create({ data: { email: target.email, userKey: target.userKey } });
    expect(replacement.id).not.toBe(target.id);
    const audit = await handle.prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'operation' } });
    expect(audit.metadata).toMatchObject({ name: 'Deleted user', email: null, unrelated: 'All systems are available' });
  });
  it('deletes an empty organisation with its sole team and org-only orphan while preserving shared accounts', async () => {
    const admin = await actor(), { owner, org, team } = await container();
    const member = await user('Org-only member'), shared = await user('Shared');
    await handle.prisma.orgMember.createMany({ data: [{ orgId: org.id, userId: member.id }, { orgId: org.id, userId: shared.id }] });
    const second = await handle.prisma.organisation.create({ data: { domain, name: 'Other company', slug: randomUUID(), ownerId: shared.id } });
    await handle.prisma.orgMember.create({ data: { orgId: second.id, userId: shared.id } });
    const preview = await getDeletionPreview('TEAM', team.id, 'RETAIN_REFERENCE');
    expect(preview.deletesEmptyOrganisation).toBe(true);
    expect(preview.candidates.find(c => c.id === member.id)?.eligible).toBe(true);
    expect(preview.candidates.find(c => c.id === shared.id)?.eligible).toBe(false);
    const job = await start('TEAM', team.id, admin);
    expect((await handle.prisma.user.findUniqueOrThrow({ where: { id: member.id } })).lifecycleStatus).toBe('DELETING');
    await acknowledge(job); await executeEntityDeletion(job.id, admin);
    expect(await handle.prisma.organisation.findUnique({ where: { id: org.id } })).toBeNull();
    expect((await handle.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).lifecycleStatus).toBe('DELETED');
    expect((await handle.prisma.user.findUniqueOrThrow({ where: { id: shared.id } })).lifecycleStatus).toBe('ACTIVE');
  });
  it('refuses stale previews after a new dependency and freezes dispatched candidates against new membership', async () => {
    const admin = await actor(), { owner, org, team } = await container();
    const preview = await getDeletionPreview('TEAM', team.id, 'RETAIN_REFERENCE');
    await handle.prisma.userSetting.create({ data: { userId: owner.id, namespace: 'personal', key: 'profile', value: {}, sizeBytes: 2 } });
    await expect(beginEntityDeletion({ scope: 'TEAM', id: team.id, mode: 'RETAIN_REFERENCE', previewDigest: preview.digest, confirmation: preview.confirmation, requestKey: randomUUID(), actor: admin })).rejects.toThrow('DELETION_PREVIEW_CHANGED');
    await handle.prisma.userSetting.deleteMany();
    const job = await start('TEAM', team.id, admin);
    await expect(handle.prisma.team.create({ data: { orgId: org.id, name: 'Late', slug: randomUUID() } })).rejects.toThrow();
    const otherOwner = await user(), other = await handle.prisma.organisation.create({ data: { domain, name: 'Other', slug: randomUUID(), ownerId: otherOwner.id } });
    await expect(handle.prisma.orgMember.create({ data: { orgId: other.id, userId: owner.id } })).rejects.toThrow();
    expect((await productDeletionJobs(job.participants[0].clientDomainId))[0]).toMatchObject({ effectiveScope: 'ORGANISATION', effectiveTargetId: org.id, accountsToDelete: [owner.id] });
  });
  it('serializes simultaneous product acknowledgements and rejects wrong domain or conflicting replay', async () => {
    const admin = await actor(), target = await user();
    const domains = [domain, 'second.lifecycle.example.com'];
    for (const d of domains) { await handle.prisma.clientDomain.create({ data: { domain: d, label: "Product" } }); await handle.prisma.domainRole.create({ data: { userId: target.id, domain: d } }); }
    const job = await start('USER', target.id, admin);
    await expect(acknowledgeProductDeletion({ jobId: job.id, clientDomainId: 'foreign', revision: 1, outcome: 'PURGED' })).rejects.toThrow('NOT_FOUND');
    await Promise.all(job.participants.map(p => acknowledgeProductDeletion({ jobId: job.id, clientDomainId: p.clientDomainId, revision: 1, outcome: 'PURGED' })));
    expect((await handle.prisma.entityDeletionJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('READY');
    await expect(acknowledgeProductDeletion({ jobId: job.id, clientDomainId: job.participants[0].clientDomainId, revision: 1, outcome: 'RETAINED_EVIDENCE' })).rejects.toThrow('DELETION_ACK_MISMATCH');
  });
  it('requires ownership transfer and preserves an unknown-product blocker', async () => {
    const admin = await actor(), { owner } = await container();
    expect((await getDeletionPreview('USER', owner.id, 'RETAIN_REFERENCE')).blockers).toContain('Transfer ownership of every retained organisation before deleting this account.');
    const target = await user(); await handle.prisma.domainRole.create({ data: { userId: target.id, domain: 'unregistered.example.com' } });
    expect((await getDeletionPreview('USER', target.id, 'RETAIN_REFERENCE')).blockers.some(b => b.includes('unregistered.example.com'))).toBe(true);
    await expect(start('USER', target.id, admin)).rejects.toThrow('DELETION_BLOCKED');
  });
  it('mailbox proof reveals only authorized reasons, is one-use, and mail failure is non-enumerating', async () => {
    const target = await user();
    await handle.prisma.user.update({ where: { id: target.id }, data: { userKey: target.email, lifecycleStatus: 'DISABLED', lifecycleReason: 'Contact support.', lifecycleInternalNote: 'Private note' } });
    const config = validateConfigFields(baseClientConfigPayload({ domain, user_scope: 'global' }));
    const context = { config, configUrl: `https://${domain}/config` };
    const challenge = await startLifecycleStatus({ ...context, email: target.email! });
    const code = store.mail.mock.calls[0][0].code as string;
    const status = await verifyLifecycleStatus({ ...context, challengeId: challenge.challengeId, code });
    expect(status.user).toMatchObject({ status: 'DISABLED', reason: 'Contact support.' });
    expect(JSON.stringify(status)).not.toContain('Private note'); expect(status).not.toHaveProperty('access_token');
    await expect(verifyLifecycleStatus({ ...context, challengeId: challenge.challengeId, code })).rejects.toThrow('AUTHENTICATION_FAILED');
    store.mail.mockRejectedValue(new Error('Provider failure'));
    await expect(startLifecycleStatus({ ...context, email: target.email! })).resolves.toMatchObject({ ok: true });
    await expect(startLifecycleStatus({ ...context, email: 'missing@example.com' })).resolves.toMatchObject({ ok: true });
  });
  it('never replaces a short name inside unrelated JSON strings', () => {
    expect(scrubIdentityJson({ name: 'Al', action: 'Always available', email: 'PERSON@EXAMPLE.COM', unrelated: 'Al' }, ['person@example.com', 'Al', 'key'])).toEqual({ name: 'Deleted user', action: 'Always available', email: null, unrelated: 'Al' });
  });
  it('scrubs target PII while keeping a retained ID and unrelated actor details', async () => {
    const admin = await actor(), target = await user('Target name');
    await handle.prisma.adminAuditLog.create({ data: { actorEmail: 'other@example.com', action: 'subject.test', metadata: {
      subject: { userId: target.id, name: target.name, ip: '192.0.2.7', userAgent: 'private browser', providerUserId: 'provider-subject' },
      actor: { userId: admin.userId, name: 'Administrator', ip: '192.0.2.8' },
    } } });
    const job = await start('USER', target.id, admin); await executeEntityDeletion(job.id, admin);
    expect((await handle.prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'subject.test' } })).metadata).toEqual({
      subject: { userId: target.id, name: 'Deleted user', ip: null, userAgent: null, providerUserId: null },
      actor: { userId: admin.userId, name: 'Administrator', ip: '192.0.2.8' },
    });
  });
  it('erases mutable references and retains an idempotent digest receipt after physical identity removal', async () => {
    const admin = await actor(), target = await user('Private name');
    await handle.prisma.adminAuditLog.create({ data: { actorEmail: 'other@example.com', action: 'erase.test', metadata: { userId: target.id, name: target.name } } });
    const job = await start('USER', target.id, admin, 'ERASE_REFERENCE');
    const result = await executeEntityDeletion(job.id, admin);
    expect(result.status).toBe('COMPLETE'); expect(await handle.prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(JSON.stringify(result)).not.toContain(target.id); expect(JSON.stringify(result)).not.toContain('Private name');
    expect((await handle.prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'erase.test' } })).metadata).toEqual({ userId: null, name: 'Deleted user' });
    expect((await executeEntityDeletion(job.id, admin)).status).toBe('COMPLETE');
  });
  it('lists restricted signing audit evidence and preserves its immutable data while clearing operational identity', async () => {
    const admin = await actor(), target = await user('Signer');
    const evidence = await handle.prisma.signatureAuditEvent.create({ data: { domain, actorUserId: target.id, actorEmail: target.email,
      action: 'legal.evidence', targetType: 'user', targetId: target.id, metadata: { signerName: 'Signer', ip: '192.0.2.9' } } });
    const preview = await getDeletionPreview('USER', target.id, 'ERASE_REFERENCE');
    expect(preview.retainedEvidence).toContainEqual(expect.objectContaining({ model: 'SignatureAuditEvent', count: 1 }));
    const job = await start('USER', target.id, admin, 'ERASE_REFERENCE'); await executeEntityDeletion(job.id, admin);
    expect((await handle.prisma.user.findUniqueOrThrow({ where: { id: target.id } })).email).toBeNull();
    expect(await handle.prisma.signatureAuditEvent.findUnique({ where: { id: evidence.id } })).toEqual(evidence);
    await expect(handle.prisma.signatureAuditEvent.delete({ where: { id: evidence.id } })).rejects.toThrow();
  });
  it('blocks overlapping sibling jobs and promotes a disabled surviving default deterministically', async () => {
    const admin = await actor(), { org, team } = await container();
    const sibling = await handle.prisma.team.create({ data: { orgId: org.id, name: 'Sibling', slug: randomUUID(), lifecycleStatus: 'DISABLED' } });
    const job = await start('TEAM', team.id, admin);
    expect((await getDeletionPreview('TEAM', sibling.id, 'RETAIN_REFERENCE')).blockers).not.toEqual([]);
    expect((await getDeletionPreview('ORGANISATION', org.id, 'RETAIN_REFERENCE')).blockers).not.toEqual([]);
    await acknowledge(job); await executeEntityDeletion(job.id, admin);
    expect((await handle.prisma.team.findUniqueOrThrow({ where: { id: sibling.id } })).isDefault).toBe(true);
    const last = await start('TEAM', sibling.id, admin); await acknowledge(last); await executeEntityDeletion(last.id, admin);
    expect(await handle.prisma.organisation.findUnique({ where: { id: org.id } })).toBeNull();
  });
  it('persists bounded progress for 25 members with 250 audit rows, resuming without duplicate effects', async () => {
    const admin = await actor(), { org, team } = await container();
    const members = await Promise.all(Array.from({ length: 25 }, (_, i) => user(`Member ${i}`)));
    await handle.prisma.orgMember.createMany({ data: members.map(member => ({ orgId: org.id, userId: member.id })) });
    await handle.prisma.teamMember.createMany({ data: members.map(member => ({ teamId: team.id, userId: member.id })) });
    await handle.prisma.adminAuditLog.createMany({ data: members.flatMap(member => Array.from({ length: 10 }, () => ({ actorEmail: 'other@example.com', action: 'scale.test', metadata: { userId: member.id, name: member.name, ip: '192.0.2.4' } }))) });
    const job = await start('ORGANISATION', org.id, admin); await acknowledge(job);
    let result = await executeEntityDeletion(job.id, admin), attempts = 1;
    expect(result.status).toBe('READY'); expect(result.progress).toHaveProperty('usersDone');
    while (result.status !== 'COMPLETE' && attempts++ < 20) result = await executeEntityDeletion(job.id, admin);
    expect(result.status).toBe('COMPLETE'); expect(attempts).toBeGreaterThan(1);
    expect(await handle.prisma.user.count({ where: { id: { in: members.map(m => m.id) }, lifecycleStatus: 'DELETED' } })).toBe(25);
    expect(await handle.prisma.adminAuditLog.count({ where: { action: 'scale.test' } })).toBe(250);
    expect(JSON.stringify(await handle.prisma.adminAuditLog.findMany({ where: { action: 'scale.test' } }))).not.toContain('192.0.2.4');
  }, 60_000);
  it('denies exact disabled team management to both organisation owners and backend actors', async () => {
    const { owner, org, team } = await container();
    const config = validateConfigFields(baseClientConfigPayload({ domain }));
    await handle.prisma.team.update({ where: { id: team.id }, data: { lifecycleStatus: 'DISABLED' } });
    for (const actorUserId of [owner.id, undefined]) expect(await hasTeamCapability(handle.prisma as unknown as OrgServicePrisma, 'teams.manage', { orgId: org.id, teamId: team.id, actorUserId, config })).toBe(false);
  });
  it('removes operational service access and unsigned continuations without inventing retention exceptions', async () => {
    const admin = await actor(), { org, team } = await container(), target = await user();
    const service = await handle.prisma.billingService.create({ data: { name: 'Product', identifier: 'product-label' } });
    const key = await handle.prisma.billingAppKey.create({ data: { serviceId: service.id, name: 'Product key', keyPrefix: 'test', secretDigest: randomUUID(), actorIssuer: `https://${domain}`, actorAudience: `https://${domain}/billing`, actorKeyId: 'key', actorPublicJwk: {} } });
    await handle.prisma.orgMember.create({ data: { orgId: org.id, userId: target.id } });
    await handle.prisma.teamMember.create({ data: { teamId: team.id, userId: target.id } });
    await handle.prisma.billingServiceAccess.create({ data: { serviceId: service.id, appKeyId: key.id, orgId: org.id, teamId: team.id, userId: target.id } });
    await handle.prisma.signingContinuation.create({ data: { tokenHash: randomUUID(), userId: target.id, domain, authProfile: 'CONFIG_JWT', configUrl: `https://${domain}/config`, redirectUrl: `https://${domain}/callback`, codeChallenge: 'challenge', codeChallengeMethod: 'S256', authMethod: 'email', policyRevision: 0, expiresAt: new Date(Date.now() + 60_000) } });
    const preview = await getDeletionPreview('USER', target.id, 'ERASE_REFERENCE');
    expect(preview.retainedEvidence).toEqual([]);
    expect(preview.participants.map(p => p.domain)).toEqual([domain]);
    expect(preview.blockers).toEqual([]);
    const job = await start('USER', target.id, admin, 'ERASE_REFERENCE'); await acknowledge(job); await executeEntityDeletion(job.id, admin);
    expect(await handle.prisma.billingServiceAccess.count({ where: { userId: target.id } })).toBe(0);
    expect(await handle.prisma.signingContinuation.count({ where: { userId: target.id } })).toBe(0);
    expect(await handle.prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
  });
  it('cascades an organisation after an earlier child deletion retained immutable billing evidence', async () => {
    const admin = await actor(), { org, team } = await container();
    await handle.prisma.team.create({ data: { orgId: org.id, name: 'Remaining', slug: randomUUID() } });
    const account = await handle.prisma.billingStripeAccount.create({ data: { stripeAccountId: `acct_${randomUUID()}`, livemode: false } });
    const customer = await handle.prisma.billingStripeCustomer.create({ data: { accountId: account.id, orgId: org.id, teamId: team.id, scope: 'TEAM', scopeKey: `${org.id}:${team.id}` } });
    const evidence = await handle.prisma.billingCreditAccount.create({ data: { accountId: account.id, customerId: customer.id, orgId: org.id, teamId: team.id, scope: 'TEAM', scopeKey: `${org.id}:${team.id}` } });
    const first = await start('TEAM', team.id, admin); await acknowledge(first); await executeEntityDeletion(first.id, admin);
    expect((await handle.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).lifecycleStatus).toBe('DELETED');
    const last = await start('ORGANISATION', org.id, admin); await acknowledge(last);
    expect((await executeEntityDeletion(last.id, admin)).status).toBe('COMPLETE');
    expect((await handle.prisma.organisation.findUniqueOrThrow({ where: { id: org.id } })).lifecycleStatus).toBe('DELETED');
    expect(await handle.prisma.billingCreditAccount.findUnique({ where: { id: evidence.id } })).toEqual(evidence);
  });
  it('returns workplace labels for mapped cross-product memberships without leaking them to unmapped products', async () => {
    const { owner, org } = await container();
    await handle.prisma.user.update({ where: { id: owner.id }, data: { userKey: owner.email } });
    await handle.prisma.organisation.update({ where: { id: org.id }, data: { lifecycleStatus: 'DISABLED', lifecycleReason: 'Workplace access paused.' } });
    const mappedDomain = 'mapped.lifecycle.example.com';
    await handle.prisma.clientDomain.create({ data: { domain: mappedDomain, label: 'Mapped product' } });
    const service = await handle.prisma.billingService.create({ data: { name: 'Mapped', identifier: `mapped-${randomUUID()}` } });
    await handle.prisma.billingAppKey.create({ data: { serviceId: service.id, purpose: 'CUSTOMER_LIFECYCLE', checkoutReturnOrigins: [`https://${mappedDomain}`], name: 'Mapped product key', keyPrefix: 'test', secretDigest: randomUUID(), actorIssuer: `https://${mappedDomain}`, actorAudience: `https://${mappedDomain}/billing`, actorKeyId: 'key', actorPublicJwk: {} } });
    for (const [productDomain, expectedCount] of [[mappedDomain, 1], ['unmapped.example.com', 0]] as const) {
      const context = { config: validateConfigFields(baseClientConfigPayload({ domain: productDomain, user_scope: 'global' })), configUrl: `https://${productDomain}/config` };
      const challenge = await startLifecycleStatus({ ...context, email: owner.email ?? '' });
      const code = store.mail.mock.calls.at(-1)?.[0].code as string;
      const result = await verifyLifecycleStatus({ ...context, challengeId: challenge.challengeId, code });
      expect(result.organisations).toHaveLength(expectedCount);
      if (expectedCount) expect(result.organisations[0]).toMatchObject({ name: 'Company', reason: 'Workplace access paused.' });
    }
  });
});
