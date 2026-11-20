import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb } from '../helpers/test-db.js';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { saveProductErasurePolicy } from '../../src/services/product-erasure-policy.service.js';
import { assertProductParticipation } from '../../src/services/product-participation.service.js';
import { confirmAccountDeletionRequest, startAccountDeletionRequest, submitProductErasure } from '../../src/services/account-deletion-request.service.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createAdminDomain } from '../../src/services/domain-secret.service.js';
import { registerProductDeletionJobs } from '../../src/routes/domain/deletion-jobs.js';
import { registerAccountDeletionRequestRoutes } from '../../src/routes/auth/account-deletion-request.js';
import { deliverProductDeletionNotices } from '../../src/services/product-erasure-notification.service.js';
import { ensureDomainRoleForUser } from '../../src/services/domain-role.service.js';
import { executeEntityDeletion, productDeletionJobs, acknowledgeProductDeletion } from '../../src/services/entity-deletion-job.service.js';
import { reviewContainer } from '../../src/services/product-erasure-containers.service.js';
import { productImpact } from '../../src/services/product-erasure.service.js';

const store = vi.hoisted(() => ({ db: null as PrismaClient | null, mail: vi.fn(), notice: vi.fn() }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => store.db!, getPrisma: () => store.db! }));
vi.mock('../../src/services/email.service.js', () => ({ sendActionVerificationEmail: store.mail, sendProductDeletionEmail: store.notice }));
describe.skipIf(!process.env.DATABASE_URL)('product account erasure', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createRlsTestDb>>>;
  let db: PrismaClient;
  let actor: { userId: string; tokenVersion: number };
  const http = Fastify();
  const credentials = new Map<string,string>();
  let tenant: PrismaClient;
  const browser = 'b'.repeat(43);
  const person = () => { const email = randomUUID() + '@example.com'; return db.user.create({ data: { email, userKey: email } }); };
  beforeAll(async () => {
    handle = (await createRlsTestDb())!; db = handle.prisma; store.db = db;
    tenant = new PrismaClient({ datasourceUrl: handle.appDatabaseUrl });
    await http.register(cookie);
    registerProductDeletionJobs(http);
    registerAccountDeletionRequestRoutes(http);
    store.mail.mockResolvedValue(undefined);
    const admin = await person();
    await db.domainRole.create({ data: { userId: admin.id, domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    actor = { userId: admin.id, tokenVersion: admin.tokenVersion };
  });
  afterAll(async () => { await http.close(); await tenant?.$disconnect(); await handle?.cleanup(); });
  async function policy(mode: 'ORGANISATION'|'PERSONAL', settings: string[] = []) {
    const id = 'p-' + randomUUID();
    const domain = id + '.example.com';
    const registered = await createAdminDomain({ domain, actorEmail: 'operator@example.test' }, { prisma: db });
    credentials.set(domain, registered.clientHash);
    return saveProductErasurePolicy({ id, name: id, mode, revision: 0, domains: [domain], nativeApps: [], settings,
      disclosure: 'Erase personal content. Retain signed invoices.', enabled: true }, actor);
  }
  async function verify(email: string, product: string, rejoin = false) {
    const { challengeId } = await startAccountDeletionRequest(email, browser, product, rejoin);
    const code = store.mail.mock.lastCall![0].code as string;
    await expect(confirmAccountDeletionRequest({ challengeId, browser, code })).rejects.toThrow();
    const preview = await confirmAccountDeletionRequest({ challengeId, browser, code, product, rejoin });
    if (!('digest' in preview)) throw new Error('Expected product preview');
    return { challengeId, digest: preview.digest, product, browser, rejoin };
  }
  it('fences one product, preserves the other account, binds consent to the policy revision and commits once', async () => {
    const a = await policy('PERSONAL', ['game/save']), b = await policy('PERSONAL', ['other/save']);
    const user = await person();
    for (const p of [a,b]) {
      await db.domainRole.create({ data: { userId: user.id, domain: p.domains[0] } });
      await db.userSetting.create({ data: { userId: user.id, namespace: p.settings[0].split('/')[0], key: 'save', value: 'mine', sizeBytes: 4 } });
    }
    const proof = await verify(user.email!, a.id);
    await expect(submitProductErasure({ ...proof, product: b.id })).rejects.toThrow();
    await expect(submitProductErasure({ ...proof, browser: 'x'.repeat(43) })).rejects.toThrow();
    await saveProductErasurePolicy({ ...a, mode: 'PERSONAL', disclosure: 'Updated retention' }, actor);
    await expect(submitProductErasure(proof)).rejects.toThrow('DELETION_PREVIEW_CHANGED');
    const fresh = await verify(user.email!, a.id);
    const receipt = await submitProductErasure(fresh);
    expect(receipt.complete).toBe(false);
    expect(await submitProductErasure(fresh)).toEqual(receipt);
    expect(await db.productErasureReceipt.count({ where: { jobId: receipt.receipt } })).toBe(1);
    const values = await db.userSetting.findMany({ where: { userId: user.id } });
    expect(values.map(v => v.namespace)).toEqual(['other']);
    await expect(assertProductParticipation(db, user.id, a.domains[0])).rejects.toThrow('PRODUCT_ACCOUNT_DELETED');
    await assertProductParticipation(db, user.id, b.domains[0]);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(user.tokenVersion);
    expect(await db.domainRole.count({ where: { domain: b.domains[0], userId: user.id } })).toBe(1);
  });
  it('offers only the exclusive named container, rechecks joins and never authorizes global account deletion', async () => {
    const p = await policy('ORGANISATION'), owner = await person(), other = await person();
    const org = await db.organisation.create({ data: { domain: p.domains[0], name: 'Studio', slug: randomUUID(), ownerId: owner.id } });
    const team = await db.team.create({ data: { orgId: org.id, name: 'Weekend', slug: randomUUID() } });
    await db.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
    await db.teamMember.create({ data: { teamId: team.id, userId: owner.id } });
    const target = { scope: 'ORGANISATION' as const, id: org.id };
    expect((await productImpact(db, owner.id, p)).impact.containers).toEqual([expect.objectContaining(target)]);
    const proof = await verify(owner.email!, p.id);
    const receipt = await submitProductErasure({ ...proof, container: target });
    expect(await db.entityDeletionJob.count({ where: { targetId: org.id } })).toBe(0);
    await db.orgMember.create({ data: { orgId: org.id, userId: other.id } });
    await expect(reviewContainer(receipt.receipt, 'approve', actor)).rejects.toThrow('DELETION_PREVIEW_CHANGED');
    expect((await productImpact(db, owner.id, p)).impact.containers).toEqual([expect.objectContaining({ scope: 'TEAM', id: team.id })]);
    const sibling = await db.team.create({data:{orgId:org.id,name:'Colleagues',slug:randomUUID()}});
    const membership = await db.teamMember.create({data:{teamId:sibling.id,userId:owner.id}});
    expect((await productImpact(db, owner.id, p)).impact.containers).toEqual([]);
    await db.teamMember.delete({where:{id:membership.id}});
    await db.teamMember.create({ data: { userId: other.id, teamId: team.id, status: 'DEACTIVATED' } });
    expect((await productImpact(db, owner.id, p)).impact.containers).toEqual([]);
    await reviewContainer(receipt.receipt, 'preserve', actor);
    expect((await http.inject('/auth/delete-account/receipt/' + receipt.receipt)).body).toContain('workspace was preserved');
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).lifecycleStatus).toBe('ACTIVE');
  });
  it('delivers only to the assigned backend, verifies acknowledgements and admits a fresh registration without restoring privileges', async () => {
    const p = await policy('PERSONAL'), other = await policy('PERSONAL'), user = await person();
    const domain = p.domains[0], unrelated = other.domains[0];
    await db.domainRole.create({ data: { userId: user.id, domain, role: 'SUPERUSER' } });
    const proof = await verify(user.email!, p.id);
    const result = await submitProductErasure(proof);
    await expect(assertProductParticipation(tenant, user.id, domain)).rejects.toThrow('PRODUCT_ACCOUNT_DELETED');
    expect(await assertProductParticipation(tenant, (await person()).id, domain)).toBe(true);
    const feed = '/domain/product-erasure-jobs';
    const request = (route: string, who: string, payload?: {revision: number; outcome: string}) =>
      http.inject({ method: payload ? 'POST' : 'GET', url: route + '?domain=' + who,
        headers: { authorization: 'Bearer ' + credentials.get(who) }, payload });
    expect((await request(feed, unrelated)).json().data).toEqual([]);
    expect((await request(feed, domain)).json().data).toMatchObject([{ id: result.receipt, subject: user.id }]);
    const ack = feed + '/' + result.receipt + '/acknowledge';
    expect((await request(ack, unrelated, { revision: 1, outcome: 'PURGED' })).statusCode).toBe(404);
    expect((await request(ack, domain, { revision: 2, outcome: 'PURGED' })).statusCode).toBe(404);
    for (let i=0; i<2; i++) expect((await request(ack, domain, { revision: 1, outcome: 'PURGED' })).statusCode).toBe(200);
    expect((await request(ack, domain, { revision: 1, outcome: 'RETAINED_EVIDENCE' })).statusCode).toBe(409);
    expect((await http.inject('/auth/delete-account/receipt/' + result.receipt)).body).toBe('Deletion complete.');
    expect((await request(feed, domain)).json().data).toEqual([]);
    expect((await db.productErasureJob.findUniqueOrThrow({ where: { id: result.receipt } })).impact).toEqual({});
    const stateUrl = '/domain/product-participation?domain=' + domain + '&subject=' + user.id;
    const access = () => http.inject({url: stateUrl, headers: {authorization: 'Bearer ' + credentials.get(domain)}});
    expect((await access()).json()).toMatchObject({active: false});
    const log = {warn: vi.fn()};
    await deliverProductDeletionNotices(log);
    await deliverProductDeletionNotices(log);
    expect(store.notice).toHaveBeenCalledOnce();
    expect(store.notice).toHaveBeenCalledWith(user.email, p.name, expect.stringContaining(result.receipt));
    await expect(verify(user.email!, p.id, true)).rejects.toThrow('PRODUCT_REJOIN_NOT_READY');
    await db.productErasureJob.update({ where: { id: result.receipt }, data: { createdAt: new Date(Date.now() - 62*60_000) } });
    const again = await verify(user.email!, p.id, true);
    await expect(submitProductErasure({ ...again, rejoin: false })).rejects.toThrow();
    await submitProductErasure(again);
    expect((await access()).json()).toMatchObject({active: true, generation: result.receipt});
    expect((await ensureDomainRoleForUser({ domain, userId: user.id, prisma: db })).role).toBe('USER');
    await submitProductErasure(proof);
    await assertProductParticipation(tenant, user.id, domain);
  });

  it('requires an exact container job and both receipts before completing an exclusive organisation', async () => {
    const p = await policy('ORGANISATION'), user = await person();
    const org = await db.organisation.create({data: { domain: p.domains[0], name: 'Private studio', slug: randomUUID(), ownerId: user.id }});
    await db.orgMember.create({data: { orgId: org.id, userId: user.id, role: 'owner' }});
    const proof = await verify(user.email!, p.id);
    const result = await submitProductErasure({...proof, container: { scope: 'ORGANISATION', id: org.id }});
    await reviewContainer(result.receipt, 'approve', actor);
    const domain = p.domains[0];
    const {id: clientDomainId} = await db.clientDomain.findUniqueOrThrow({where:{domain}});
    const [entity] = await productDeletionJobs(clientDomainId);
    expect(entity).toMatchObject({ effectiveScope: 'ORGANISATION', effectiveTargetId: org.id, accountsToDelete: [] });
    await acknowledgeProductDeletion({ clientDomainId, jobId: entity.id, revision: entity.revision, outcome: 'PURGED', authority: { domain, token: credentials.get(domain)! } });
    await executeEntityDeletion(entity.id, actor);
    expect(await db.organisation.findUnique({where:{id:org.id}})).toBeNull();
    expect((await db.productErasureJob.findUniqueOrThrow({where:{id:result.receipt}})).completedAt).toBeNull();
    const done = await http.inject({ method: 'POST', url: '/domain/product-erasure-jobs/' + result.receipt + '/acknowledge?domain=' + domain,
      headers: { authorization: 'Bearer ' + credentials.get(domain) }, payload: {revision: 1, outcome:'PURGED'} });
    expect(done.statusCode).toBe(200);
    expect((await db.productErasureJob.findUniqueOrThrow({where:{id:result.receipt}})).completedAt).toBeTruthy();
    expect((await db.user.findUniqueOrThrow({where:{id:user.id}})).lifecycleStatus).toBe('ACTIVE');
  });
  it('blocks only the mapped native app and prevents erased settings from returning through a second client', async () => {
    const user = await person(), id = 'n-' + randomUUID();
    const app = await db.nativeApp.create({ data: { identifier: id, name: 'Game', redirectUris: ['game://callback'], scopes: ['openid'],
      methods: ['google'], primaryColor: '#ffffff', backgroundColor: '#ffffff', textColor: '#111111' } });
    const key = 'native-' + randomUUID();
    await saveProductErasurePolicy({ id, name: 'Game', mode: 'PERSONAL', revision: 0, enabled: true, domains: [], nativeApps: [app.identifier],
      settings: ['game/' + key], disclosure: 'Erase cloud saves' }, actor);
    expect((await submitProductErasure(await verify(user.email!, id))).complete).toBe(true);
    await expect(assertProductParticipation(tenant, user.id, 'common.example.test', id)).rejects.toThrow('PRODUCT_ACCOUNT_DELETED');
    await assertProductParticipation(tenant, user.id, 'common.example.test', 'different-app');
    await expect(db.userSetting.create({data: {userId:user.id,namespace:'game',key,value:'old save',sizeBytes:8}})).rejects.toThrow('PRODUCT_ACCOUNT_DELETED');
  });

  it('requires an independent personal credential for managed mailboxes and invalidates a proof when the credential changes', async () => {
    const p = await policy('PERSONAL'), domain = randomUUID()+'.example.test';
    const email = 'employee@'+domain, password = 'test-password-'+randomUUID();
    const user = await db.user.create({data:{ email, userKey:email, passwordHash: await hashPassword(password) }});
    const org = await db.organisation.create({data:{ domain:p.domains[0], name:'Test',slug:randomUUID(), ownerId:user.id }});
    await db.organisationEmailDomain.create({data:{clientDomain:p.domains[0],orgId:org.id,emailDomain:domain,challengeHash:randomUUID(),challengeExpiresAt:new Date(Date.now()+60000),verifiedAt:new Date()}});
    const {challengeId} = await startAccountDeletionRequest(email, browser, p.id);
    const proof = {challengeId, browser, product:p.id, code: store.mail.mock.lastCall![0].code};
    await expect(confirmAccountDeletionRequest(proof)).rejects.toThrow('INDEPENDENT_REAUTH_REQUIRED');
    await expect(confirmAccountDeletionRequest({...proof,password:'incorrect'})).rejects.toThrow();
    const preview = await confirmAccountDeletionRequest({...proof,password});
    if (!('digest' in preview)) throw new Error('Expected preview');
    await db.user.update({where:{id:user.id},data:{passwordHash:null}});
    await expect(submitProductErasure({...proof,digest:preview.digest})).rejects.toThrow();
    expect(await db.productErasureJob.count({where:{subject:user.id}})).toBe(0);
  });
  it('does not substitute a global subject for a same-mailbox per-domain account', async () => {
    const p = await policy('PERSONAL'), global = await person(), email = global.email!;
    await db.user.create({ data: { email, domain: p.domains[0], userKey: p.domains[0] + '|' + email } });
    const {challengeId} = await startAccountDeletionRequest(email, browser, p.id);
    expect(await db.verificationToken.findUnique({where:{id:challengeId}})).toBeNull();
    expect(await db.productErasureJob.count({where:{subject:global.id}})).toBe(0);
  });
  it('keeps a multi-backend receipt pending until every assigned backend commits its cleanup', async () => {
    const first = await policy('PERSONAL'), user = await person();
    const extra = await createAdminDomain({domain: randomUUID() + '.example.test', actorEmail:'operator@example.test'}, {prisma:db});
    const policyRow = await saveProductErasurePolicy({...first, mode:'PERSONAL', domains:[...first.domains,extra.domain.domain]}, actor);
    const result = await submitProductErasure(await verify(user.email!, first.id));
    const receipt = '/auth/delete-account/receipt/' + result.receipt;
    const ack = (domain: string, token: string, outcome: string) => http.inject({ method: 'POST',
      url: '/domain/product-erasure-jobs/' + result.receipt + '/acknowledge?domain=' + domain,
      headers: { authorization: 'Bearer ' + token }, payload: { revision: policyRow.revision, outcome } });
    expect((await ack(first.domains[0], credentials.get(first.domains[0])!, 'PURGED')).statusCode).toBe(200);
    expect((await http.inject(receipt)).body).toContain('Deletion in progress');
    expect((await ack(extra.domain.domain, extra.clientHash, 'RETAINED_EVIDENCE')).statusCode).toBe(200);
    expect((await http.inject(receipt)).body).toBe('Deletion complete. Restricted evidence was retained.');
  });
});
