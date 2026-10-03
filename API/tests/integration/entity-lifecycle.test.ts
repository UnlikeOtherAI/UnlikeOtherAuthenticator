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
});
