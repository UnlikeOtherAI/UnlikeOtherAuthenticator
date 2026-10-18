import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { TEST_SHARED_SECRET } from '../helpers/test-config.js';
import { computeTotp } from '../helpers/totp.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { generateTotpSecret } from '../../src/services/totp.service.js';
import { recoveryReadiness, setRecoveryContacts } from '../../src/services/enterprise-recovery-policy.service.js';
import { startRecoveryChallenge, completeRecoveryChallenge } from '../../src/services/enterprise-recovery-action.service.js';
import { lockEnterpriseOutbox } from '../../src/services/org-sso-revocation.service.js';
import type { managementSession } from '../../src/services/org-sso-management.service.js';

const stores = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => stores.db, getPrisma: () => stores.db }));
describe('narrow independently authenticated recovery with real PostgreSQL', () => {
  let handle: RlsTestDbHandle; let db: PrismaClient;
  let handles: Array<{ user_id: string; recovery_url: string }>;
  const suffix = randomUUID(); const domain = `recovery-${suffix}.example.com`;
  const owner = `owner-${suffix}`; const contact = `contact-${suffix}`; const org = `org-${suffix}`;
  const otherOrg = `other-${suffix}`; const secret = generateTotpSecret(); const secondSecret = generateTotpSecret();
  const session = { userId: owner, orgId: org, clientDomain: domain } as Awaited<ReturnType<typeof managementSession>>;
  const contactHandle = (index: number) => new URLSearchParams(new URL(handles[index].recovery_url).hash.slice(1)).get('contact') ?? '';
  const configure = (revision: number, ids: string[]) => db.$transaction(async (tx) => {
    await lockEnterpriseOutbox(tx); return setRecoveryContacts(session, revision, ids, tx);
  });
  beforeAll(async () => {
    const created = await createRlsTestDb(); if (!created) throw new Error('DATABASE_URL required for recovery coverage');
    handle = created; db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    await db.$connect(); stores.db = db;
    await db.clientDomain.create({ data: { domain, label: 'Recovery' } });
    await db.user.createMany({ data: [[owner, secret], [contact, secondSecret]].map(([id, factor]) => ({
      id, userKey: id, email: `${id}@example.com`, twoFaEnabled: true,
      twoFaSecret: encryptTwoFaSecret({ secret: factor, sharedSecret: TEST_SHARED_SECRET }),
    })) });
    for (const id of [org, otherOrg]) {
      await db.organisation.create({ data: { id, domain, ownerId: owner, name: id, slug: id } });
      await db.orgMember.create({ data: { orgId: id, userId: owner, role: 'owner' } });
      await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: id, arrangementEnabled: true } });
      await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId: id, preset: 'other_oidc', protocol: 'oidc',
        configuration: {}, displayName: 'Connection', status: 'active' } });
    }
    await db.orgMember.create({ data: { orgId: org, userId: contact, role: 'member' } });
  }, 120000);
  afterAll(async () => { vi.useRealTimers(); stores.db = null; await db?.$disconnect(); await handle?.cleanup(); });

  it('requires two distinct existing-factor members, permits the canonical owner, and grants no owner role', async () => {
    await expect(configure(1, [owner, owner])).rejects.toThrow('RECOVERY_TWO_CONTACTS_REQUIRED');
    handles = (await configure(1, [owner, contact])).invitations;
    expect((await recoveryReadiness(domain, org, db)).setup_complete).toBe(false);
    expect((await db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: org, userId: contact } } })).role).toBe('member');
    expect((await db.organisation.findUniqueOrThrow({ where: { id: org } })).ownerId).toBe(owner);
  });
  it('requires original browser binding and commits bounded bad guesses without creating a session', async () => {
    const started = await startRecoveryChallenge({ contact: contactHandle(0), purpose: 'confirm', browser: 'original' });
    await expect(completeRecoveryChallenge({ challenge: started.challenge, browser: 'foreign', code: '000000' })).rejects.toThrow();
    for (let i = 0; i < 6; i++) await expect(completeRecoveryChallenge({ challenge: started.challenge, browser: 'original', code: 'bad' })).rejects.toThrow();
    const row = await db.enterpriseRecoveryChallenge.findFirstOrThrow();
    expect(row.attempts).toBe(6); expect(row.consumedAt).toBeNull();
    expect(await db.sessionAssurance.count()).toBe(0); expect(await db.authenticationEvidence.count()).toBe(0);
  });
  it('tests both old factors before readiness and performs only exact org/product emergency suspension', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); const baseline = Date.now();
    try {
      for (const purpose of ['confirm', 'drill'] as const) {
        vi.setSystemTime(baseline + (purpose === 'drill' ? 30000 : 0));
        for (let index = 0; index < handles.length; index++) {
          const started = await startRecoveryChallenge({ contact: contactHandle(index), purpose, browser: `browser-${index}` });
          const factor = handles[index].user_id === owner ? secret : secondSecret;
          expect(await completeRecoveryChallenge({ challenge: started.challenge, browser: `browser-${index}`,
            code: computeTotp({ secret: factor, nowMs: Date.now() }) })).toEqual({ ok: true, action: purpose });
          await expect(completeRecoveryChallenge({ challenge: started.challenge, browser: `browser-${index}`,
            code: computeTotp({ secret: factor, nowMs: Date.now() }) })).rejects.toThrow();
        }
      }
      expect(await recoveryReadiness(domain, org, db)).toMatchObject({ setup_complete: true, drill_complete: true });
      await db.orgSsoPolicy.update({ where: { clientDomain_orgId: { clientDomain: domain, orgId: org } }, data: { enforcement: 'required_for_all_members' } });
      await expect(configure(2, [owner, contact])).rejects.toThrow('RECOVERY_DISABLE_ENFORCEMENT_FIRST');
      vi.setSystemTime(baseline + 60000);
      const started = await startRecoveryChallenge({ contact: contactHandle(0), purpose: 'recover', browser: 'recovery-browser' });
      const factor = handles[0].user_id === owner ? secret : secondSecret;
      await completeRecoveryChallenge({ challenge: started.challenge, browser: 'recovery-browser', code: computeTotp({ secret: factor, nowMs: Date.now() }) });
      expect((await db.orgSsoPolicy.findUniqueOrThrow({ where: { clientDomain_orgId: { clientDomain: domain, orgId: org } } })).enforcement).toBe('off');
      expect((await db.orgSsoConnection.findFirstOrThrow({ where: { orgId: org } })).status).toBe('suspended');
      expect((await db.orgSsoConnection.findFirstOrThrow({ where: { orgId: otherOrg } })).status).toBe('active');
      expect(await db.orgRevocationEvent.count({ where: { orgId: org, scope: 'product_org' } })).toBeGreaterThan(0);
      expect(await db.orgRevocationEvent.count({ where: { orgId: otherOrg } })).toBe(0);
      expect(await db.sessionAssurance.count()).toBe(0);
      expect((await db.organisation.findUniqueOrThrow({ where: { id: org } })).ownerId).toBe(owner);
    } finally { vi.useRealTimers(); }
  });
  it('withdraws readiness and recovery authority after the original factor changes', async () => {
    const person = handles[0].user_id;
    await db.user.update({ where: { id: person }, data: { twoFaSecret: encryptTwoFaSecret({ secret: generateTotpSecret(), sharedSecret: TEST_SHARED_SECRET }) } });
    expect((await recoveryReadiness(domain, org, db)).setup_complete).toBe(false);
    await expect(startRecoveryChallenge({ contact: contactHandle(0), purpose: 'recover', browser: 'attacker' })).rejects.toThrow();
  });
});
