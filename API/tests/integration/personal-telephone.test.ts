import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '../../src/db/prisma.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { registerTelephoneProfileRoutes } from '../../src/routes/apps/telephone-profile.js';
import { createBillingAppKey, verifyBillingAppKey, type VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';
import { LOOKUP_PATH } from '../../src/services/telephone-authority.service.js';
import { telephoneProfile, type TelephoneAction } from '../../src/services/telephone-profile.service.js';
import { CALL_PROOF_PATH, telephoneCallProof } from '../../src/services/telephone-call-proof.service.js';
import { teamTelephoneNumbers } from '../../src/services/telephone-directory.service.js';
import { lookupTelephone } from '../../src/services/telephone-lookup.service.js';
import { createTestDb } from '../helpers/test-db.js';

describe.skipIf(!process.env.DATABASE_URL)('personal telephone authority', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let privateKey: CryptoKey;
  let credential: VerifiedBillingAppKey;
  let appKey: string;
  let userId: string;
  let orgId: string;
  let teamId: string;
  const publicBase = 'https://authentication.unlikeotherai.com';
  const number = '+447700900001';
  const nextNumber = '+447700900002';
  beforeAll(async () => {
    vi.stubEnv('PUBLIC_BASE_URL', publicBase);
    db = (await createTestDb())!;
    vi.spyOn(database, 'getAdminPrisma').mockReturnValue(db.prisma);
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk = { ...await exportJWK(pair.publicKey), kid: 'telephone-test' };
    const user = await db.prisma.user.create({ data: { email: 'phone@example.test', userKey: 'phone@example.test' } });
    userId = user.id;
    const org = await db.prisma.organisation.create({ data: {
      name: 'Telephone', slug: 'telephone', domain: 'api.nessie.works', ownerId: userId } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: { name: 'Team', slug: 'team', orgId, isDefault: true } });
    teamId = team.id;
    await db.prisma.orgMember.create({ data: { userId, orgId, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { userId, teamId, teamRole: 'owner' } });
    const service = await db.prisma.billingService.create({ data: { identifier: 'nessie', name: 'Nessie' } });
    const key = await createBillingAppKey({ serviceId: service.id, purpose: 'customer_lifecycle',
      name: 'Telephone test', actorIssuer: 'https://api.nessie.works',
      actorAudience: `${publicBase}/billing/v1/effective-tariff`, actorPublicJwk: jwk,
      checkoutReturnOrigins: ['https://app.nessie.works'] }, { prisma: db.prisma });
    appKey = key.plaintext;
    credential = await verifyBillingAppKey(appKey, { prisma: db.prisma });
  });
  beforeEach(async () => {
    await db.prisma.telephoneCallChallenge.deleteMany();
    await db.prisma.telephoneLookup.deleteMany();
    await db.prisma.telephoneChallenge.deleteMany();
    await db.prisma.userTelephone.deleteMany();
    await db.prisma.user.update({ where: { id: userId }, data: { tokenVersion: 0 } });
    await db.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { status: 'ACTIVE' } });
  });
  afterAll(async () => { await db?.cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  async function actor(action: TelephoneAction) {
    return new SignJWT({ product: 'nessie', organisation_id: orgId, team_id: teamId, tv: 0 })
      .setProtectedHeader({ alg: 'RS256', kid: credential.actorKeyId }).setSubject(userId)
      .setIssuer(credential.actorIssuer).setAudience(`${publicBase}/apps/v1/nessie/phone-profile/${action}`)
      .setJti(randomUUID()).setIssuedAt().setExpirationTime('60s').sign(privateKey);
  }
  async function profile(action: TelephoneAction, data: Parameters<typeof telephoneProfile>[0]['data'] = {}) {
    return telephoneProfile({ credential, actorToken: await actor(action), action, data,
      request: { product: 'nessie', organisationId: orgId, teamId, userId } },
    { prisma: db.prisma, generateCode: () => '123456' });
  }
  async function start(value = number) {
    const result = await profile('start', { number: value });
    if (!('challengeId' in result)) throw new Error('missing delivery');
    return result;
  }
  async function verify(value = number) {
    const challenge = await start(value);
    return profile('verify', { challengeId: challenge.challengeId, code: '123456' });
  }
  async function serviceToken(value = number, callId = randomUUID(), extra: Record<string, unknown> = {}) {
    return new SignJWT({ purpose: 'telephone-routing', product: 'nessie', organisation_id: orgId, team_id: teamId,
      call_id: callId, number_digest: createHash('sha256').update(value).digest('hex'), ...extra })
      .setProtectedHeader({ alg: 'RS256', kid: credential.actorKeyId, typ: 'uoa-telephone-routing+jwt' })
      .setIssuer(credential.actorIssuer).setAudience(`${publicBase}${LOOKUP_PATH}`)
      .setJti(randomUUID()).setIssuedAt().setExpirationTime('60s').sign(privateKey);
  }
  async function lookup(value = number, callId = randomUUID(), extra: Record<string, unknown> = {}) {
    return lookupTelephone({ credential, serviceToken: await serviceToken(value, callId, extra), number: value }, { prisma: db.prisma });
  }

  async function proofToken(action: 'start' | 'verify', callId: string, value = number) {
    return new SignJWT({ purpose: 'telephone-call-proof', product: 'nessie', organisation_id: orgId, team_id: teamId,
      call_id: callId, number_digest: createHash('sha256').update(value).digest('hex') })
      .setProtectedHeader({ alg: 'RS256', kid: credential.actorKeyId, typ: 'uoa-telephone-call-proof+jwt' })
      .setIssuer(credential.actorIssuer).setAudience(`${publicBase}${CALL_PROOF_PATH}/${action}`)
      .setJti(randomUUID()).setIssuedAt().setExpirationTime('60s').sign(privateKey);
  }
  async function proof(action: 'start' | 'verify', callId: string, challengeId?: string, code = '654321') {
    return telephoneCallProof({ credential, action, serviceToken: await proofToken(action, callId), number, challengeId, code },
      { prisma: db.prisma, generateCode: () => '654321' });
  }
  async function beginProof(callId = randomUUID()) {
    await lookup(number, callId);
    const result = await proof('start', callId);
    if (!('challengeId' in result)) throw new Error('missing proof challenge');
    return { ...result, callId };
  }

  it('consumes a call proof once under concurrent verification and never creates a login', async () => {
    await verify();
    const challenge = await beginProof();
    const results = await Promise.all([proof('verify', challenge.callId, challenge.challengeId),
      proof('verify', challenge.callId, challenge.challengeId)]);
    expect(results.filter(result => result.status === 'verified')).toHaveLength(1);
    expect(results.filter(result => result.status === 'used')).toHaveLength(1);
    expect(results.find(result => result.status === 'verified')).toMatchObject({ authentication: 'telephone_sms',
      subject: userId, tokenVersion: 0, organisationId: orgId, teamId, callId: challenge.callId });
    expect(await db.prisma.refreshToken.count()).toBe(0);
  });

  it('distinguishes call-proof no-match, pending and ambiguous without a subject', async () => {
    const call = randomUUID();
    await lookup(number, call);
    expect(await proof('start', call)).toEqual({ status: 'no_match', authentication: 'none' });
    await profile('set', { number });
    expect(await proof('start', call)).toEqual({ status: 'pending', authentication: 'none' });
    await verify();
    const other = await db.prisma.user.create({ data: { email: 'proof-other@example.test', userKey: 'proof-other@example.test' } });
    await db.prisma.orgMember.create({ data: { userId: other.id, orgId, role: 'member' } });
    await db.prisma.teamMember.create({ data: { userId: other.id, teamId, teamRole: 'member' } });
    await db.prisma.userTelephone.create({ data: { userId: other.id, pendingNumber: number } });
    expect(await proof('start', call)).toEqual({ status: 'ambiguous', authentication: 'none' });
  });

  it('persists wrong call-code attempts and refuses cross-call, expiry and revoked epochs', async () => {
    await verify();
    const challenge = await beginProof();
    const otherCall = randomUUID();
    await lookup(number, otherCall);
    await expect(proof('verify', otherCall, challenge.challengeId)).rejects.toMatchObject({ statusCode: 403 });
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await proof('verify', challenge.callId, challenge.challengeId, '000000')).toEqual({ status: 'invalid', authentication: 'none' });
    }
    expect(await proof('verify', challenge.callId, challenge.challengeId)).toEqual({ status: 'invalid', authentication: 'none' });
    expect((await db.prisma.telephoneCallChallenge.findUniqueOrThrow({ where: { id: challenge.challengeId } })).attempts).toBe(5);
    const second = await beginProof();
    await db.prisma.telephoneCallChallenge.update({ where: { id: second.challengeId }, data: { expiresAt: new Date(0) } });
    expect(await proof('verify', second.callId, second.challengeId)).toEqual({ status: 'expired', authentication: 'none' });
    const third = await beginProof();
    await db.prisma.user.update({ where: { id: userId }, data: { tokenVersion: 1 } });
    expect(await proof('verify', third.callId, third.challengeId)).toEqual({ status: 'invalid', authentication: 'none' });
  });

  it('limits call-proof issuance per call and person and rejects replayed start assertions', async () => {
    await verify();
    const call = randomUUID();
    await lookup(number, call);
    const token = await proofToken('start', call);
    const input = { credential, action: 'start' as const, serviceToken: token, number };
    await telephoneCallProof(input, { prisma: db.prisma });
    await expect(telephoneCallProof(input, { prisma: db.prisma })).rejects.toMatchObject({ statusCode: 403 });
    await proof('start', call);
    await proof('start', call);
    await expect(proof('start', call)).rejects.toMatchObject({ statusCode: 429 });
    await beginProof();
    await beginProof();
    await expect(beginProof()).rejects.toMatchObject({ statusCode: 429 });
  });

  it('retains verified private routing during replacement and resets visibility on verification', async () => {
    expect(await lookup()).toEqual({ match: null, authentication: 'none' });
    await verify();
    expect(await lookup()).toMatchObject({ match: { state: 'verified', subject: userId }, authentication: 'none' });
    await profile('visibility', { visibility: 'team' });
    const challenge = await start(nextNumber);
    expect(challenge.delivery).toEqual({ number: nextNumber, code: '123456' });
    expect(await profile('read')).toMatchObject({ phone: { number, pendingNumber: nextNumber, visibility: 'team' } });
    expect(await lookup(nextNumber)).toEqual({ match: { state: 'pending' }, authentication: 'none' });
    expect(await lookup()).toMatchObject({ match: { state: 'verified', subject: userId } });
    await profile('verify', { challengeId: challenge.challengeId, code: '123456' });
    expect(await profile('read')).toMatchObject({ phone: { number: nextNumber, pendingNumber: null, visibility: 'private' } });
    expect(await lookup()).toEqual({ match: null, authentication: 'none' });
    await profile('remove');
    expect(await profile('read')).toEqual({ phone: null });
  });

  it('stores an unverified claim without any challenge or sender', async () => {
    await profile('set', { number });
    expect(await profile('read')).toMatchObject({ phone: { number: null, pendingNumber: number, visibility: 'private' } });
    expect(await db.prisma.telephoneChallenge.count()).toBe(0);
    expect(await lookup()).toEqual({ match: { state: 'pending' }, authentication: 'none' });
    await verify();
    await profile('visibility', { visibility: 'team' });
    const challenge = await start();
    await profile('set', { number: nextNumber });
    expect(await profile('read')).toMatchObject({ phone: { number, pendingNumber: nextNumber, visibility: 'team' } });
    await expect(profile('verify', { challengeId: challenge.challengeId, code: '123456' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('commits five failed attempts and refuses correct code afterwards', async () => {
    const challenge = await start();
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(profile('verify', { challengeId: challenge.challengeId, code: '000000' })).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(profile('verify', { challengeId: challenge.challengeId, code: '123456' })).rejects.toMatchObject({ statusCode: 403 });
    const row = await db.prisma.telephoneChallenge.findUniqueOrThrow({ where: { id: challenge.challengeId } });
    expect(row.attempts).toBe(5);
    expect(row.codeHash).not.toContain('123456');
    expect(await lookup()).toEqual({ match: { state: 'pending' }, authentication: 'none' });
  });

  it('invalidates old challenges on replacement, expiry and removal', async () => {
    const first = await start();
    const second = await start(nextNumber);
    await expect(profile('verify', { challengeId: first.challengeId, code: '123456' })).rejects.toMatchObject({ statusCode: 403 });
    await db.prisma.telephoneChallenge.update({ where: { id: second.challengeId }, data: { expiresAt: new Date(0) } });
    await expect(profile('verify', { challengeId: second.challengeId, code: '123456' })).rejects.toMatchObject({ statusCode: 403 });
    const third = await start();
    await profile('remove');
    await expect(profile('verify', { challengeId: third.challengeId, code: '123456' })).rejects.toMatchObject({ statusCode: 403 });
    expect(await lookup()).toEqual({ match: null, authentication: 'none' });
  });

  it('serializes concurrent starts and enforces the durable issuance ceiling', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => start()));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await db.prisma.telephoneChallenge.count({ where: { userId, usedAt: null } })).toBe(1);
  });

  it('returns no identity for ambiguity and rechecks membership for the same call', async () => {
    await verify();
    const other = await db.prisma.user.create({ data: { email: 'other-phone@example.test', userKey: 'other-phone@example.test' } });
    await db.prisma.orgMember.create({ data: { userId: other.id, orgId, role: 'member' } });
    await db.prisma.teamMember.create({ data: { userId: other.id, teamId, teamRole: 'member' } });
    await db.prisma.userTelephone.create({ data: { userId: other.id, pendingNumber: number } });
    expect(await lookup()).toEqual({ match: { state: 'ambiguous' }, authentication: 'none' });
    await db.prisma.userTelephone.delete({ where: { userId: other.id } });
    const call = randomUUID();
    expect(await lookup(number, call)).toMatchObject({ match: { subject: userId } });
    await db.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { status: 'REMOVED' } });
    expect(await lookup(number, call)).toEqual({ match: null, authentication: 'none' });
    await expect(profile('read')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('binds service assertions to number, team and call and rejects fabricated human claims', async () => {
    await verify();
    await expect(lookup(number, randomUUID(), { sub: userId })).rejects.toMatchObject({ statusCode: 403 });
    await expect(lookup(number, randomUUID(), { number_digest: '0'.repeat(64) })).rejects.toMatchObject({ statusCode: 403 });
    expect(await lookup(number, randomUUID(), { team_id: randomUUID() })).toEqual({ match: null, authentication: 'none' });
    const call = randomUUID();
    await lookup(number, call);
    await expect(lookup(nextNumber, call)).rejects.toMatchObject({ statusCode: 403 });
    await db.prisma.user.update({ where: { id: userId }, data: { tokenVersion: 1 } });
    await expect(profile('read')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('shares only verified team-visible numbers with live same-team colleagues', async () => {
    const read = (actorUserId: string | undefined = userId, selectedTeam = teamId) => teamTelephoneNumbers({
      orgId, teamId: selectedTeam, actorUserId, userIds: [userId],
    }, { prisma: db.prisma });
    await profile('set', { number });
    await profile('visibility', { visibility: 'team' });
    expect((await read()).size).toBe(0);
    await verify();
    expect((await read()).size).toBe(0);
    await profile('visibility', { visibility: 'team' });
    expect((await read()).get(userId)).toBe(number);
    const colleague = await db.prisma.user.create({ data: { email: 'directory@example.test', userKey: 'directory@example.test' } });
    await db.prisma.orgMember.create({ data: { userId: colleague.id, orgId, role: 'member' } });
    await db.prisma.teamMember.create({ data: { userId: colleague.id, teamId, teamRole: 'member' } });
    expect((await read(colleague.id)).get(userId)).toBe(number);
    await db.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId: colleague.id } }, data: { status: 'REMOVED' } });
    expect((await read(colleague.id)).size).toBe(0);
    await profile('set', { number: nextNumber });
    expect((await read()).get(userId)).toBe(number);
    expect((await read(randomUUID())).size).toBe(0);
    expect((await read(userId, randomUUID())).size).toBe(0);
    expect((await teamTelephoneNumbers({ orgId, teamId, userIds: [userId] }, { prisma: db.prisma })).size).toBe(0);
    await db.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { status: 'REMOVED' } });
    expect((await read()).size).toBe(0);
  });

  it('denies tenant-role access even when table grants are present', async () => {
    await verify();
    await db.prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${db.schema}" TO uoa_app`);
    await db.prisma.$executeRawUnsafe(`GRANT SELECT ON "${db.schema}".user_telephones TO uoa_app`);
    const rows = await db.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE uoa_app');
      return tx.userTelephone.findMany();
    });
    expect(rows).toEqual([]);
  });

  it('requires separate headers and emits private HTTP responses', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    registerTelephoneProfileRoutes(app);
    const url = '/apps/v1/nessie/phone-profile/start';
    const payload = { product: 'nessie', organisation_id: orgId, team_id: teamId, user_id: userId, number };
    try {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      const result = await app.inject({ method: 'POST', url, payload,
        headers: { 'x-uoa-app-key': appKey, 'x-uoa-actor': await actor('start') } });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.json().delivery.code).toBeDefined();
      const lookupResult = await app.inject({ method: 'POST', url: LOOKUP_PATH, payload: { number },
        headers: { 'x-uoa-app-key': appKey, 'x-uoa-service-assertion': await serviceToken(), 'x-uoa-actor': await actor('read') } });
      expect(lookupResult.statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
