import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { machineHarness, machineConfigUrl, type MachineHarness } from '../helpers/machine-fixture.js';
import { MachineDecisionResponse, MachineRecoveryResponse, machineCapabilities } from '../../src/services/machine-contract.js';
import { retainedEvidence } from '../../src/services/entity-deletion-preview.service.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { computeTotp } from '../helpers/totp.js';

describe('machine v1 explicit human consent over the authenticated supported HTTP interface', () => {
  let h: MachineHarness;
  beforeAll(async () => { h = await machineHarness(); });
  afterAll(async () => { await h?.cleanup(); });

  it('publishes the exact authenticated capability and public strict schemas without issuing authority', async () => {
    const before = await h.db.prisma.machineEnrollment.count();
    const capability = await h.api('/capabilities', {}, 'GET');
    expect(capability.statusCode, capability.body).toBe(200);
    expect(capability.json()).toEqual(machineCapabilities);
    expect((await h.api('/capabilities', {}, 'GET', 'wrong')).statusCode).toBe(401);
    const schema = await h.app.inject({ method: 'GET', url: '/schemas/machine-enrollment-v1.json' });
    expect(schema.statusCode, schema.body).toBe(200);
    expect(schema.json()).toMatchObject({ version: 1, capability: 'machine_enrollment_v1',
      binding: { type: 'object', additionalProperties: false }, unavailable: { type: 'object', additionalProperties: false } });
    expect(Object.keys(schema.json().unavailable.properties).sort()).toEqual(['decision', 'reason']);
    expect(await h.db.prisma.machineEnrollment.count()).toBe(before);
  });

  it('creates no grant on intent, proof, GET or successful login; only an explicit protected consent POST creates it', async () => {
    const f = await h.fixture();
    const intent = await f.request();
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id } })).toBe(0);
    const possession = await h.api(`/authorization-requests/${intent.request_id}/proof`, { proof: f.proof(intent) });
    expect(possession.statusCode).toBe(200);
    const session = await f.human(intent.request_id);
    expect(session.state.request.status).toBe('pending');
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id } })).toBe(0);
    const unauthenticatedGet = await h.app.inject({ method: 'GET', url: '/auth/machines/state' });
    expect(unauthenticatedGet.statusCode).toBe(401);
    for (const [cookie, csrf, origin] of [[undefined, session.csrf, undefined], [session.cookie, 'wrong', undefined],
      [session.cookie, session.csrf, 'https://attacker.example.com']] as const) {
      const denied = await h.browser('/auth/machines/consent', { approved: true }, cookie, csrf, origin);
      expect([401, 403]).toContain(denied.statusCode);
    }
    const results = await Promise.all([1, 2].map(() => h.browser('/auth/machines/consent', { approved: true }, session.cookie, session.csrf)));
    expect(results.map(row => row.statusCode)).toEqual([200, 200]);
    expect(results[0].json()).toEqual(results[1].json());
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id } })).toBe(1);
    expect(await h.db.prisma.machineAuthorization.count({ where: { requestId: intent.request_id } })).toBe(1);
    expect(await h.db.prisma.machineCredential.count({ where: { operationId: intent.request_id } })).toBe(1);
    expect(await h.db.prisma.sessionAssurance.count({ where: { userId: f.user.id } })).toBe(0);
    const result = await h.api(`/authorization-requests/${intent.request_id}/result`);
    expect(result.json()).toMatchObject({ status: 'authorized', operation_id: intent.request_id });
    expect(result.body).not.toContain('credential');
    const recovery = await f.recover(intent.request_id);
    expect(MachineRecoveryResponse.parse(recovery.result.json())).toMatchObject({ outcome: 'recovered', fresh_validation_required: true });
    expect(recovery.result.json()).not.toHaveProperty('decision');
    expect((await h.browser('/auth/machines/consent', { approved: false }, session.cookie, session.csrf)).statusCode).toBe(409);
  });

  it('completes the actual personal TOTP flow before explicit consent, even when ordinary product 2FA is off', async () => {
    const f = await h.fixture(); const secret = 'JBSWY3DPEHPK3PXP';
    await h.db.prisma.user.update({ where: { id: f.user.id }, data: { twoFaEnabled: true,
      twoFaSecret: encryptTwoFaSecret({ secret, sharedSecret: process.env.SHARED_SECRET! }) } });
    const intent = await f.request();
    await h.api(`/authorization-requests/${intent.request_id}/proof`, { proof: f.proof(intent) });
    const token = await f.login(intent.request_id);
    const started = await h.browser('/auth/machines/start', { login_token: token, organization_id: f.org.id, team_id: f.team.id, request_id: intent.request_id });
    expect(started.statusCode, started.body).toBe(200); expect(started.json().twofa_required).toBe(true);
    const cookie = String(started.headers['set-cookie']).split(';')[0];
    expect((await h.app.inject({ method: 'GET', url: '/auth/machines/state', headers: { cookie } })).statusCode).toBe(401);
    const verify = (code: string) => h.app.inject({ method: 'POST', url: '/2fa/verify?' + new URLSearchParams({ config_url: machineConfigUrl }),
      payload: { twofa_token: started.json().twofa_token, code } });
    expect((await verify('invalid')).statusCode).toBe(400);
    const currentCode = computeTotp({ secret, nowMs: Date.now() });
    const wrongCode = currentCode === '000000' ? '000001' : '000000';
    const wrong = await verify(wrongCode);
    expect(wrong.statusCode, wrong.body).toBe(401);
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id } })).toBe(0);
    const verified = await verify(computeTotp({ secret, nowMs: Date.now() }));
    expect(verified.statusCode, verified.body).toBe(200);
    const state = await h.app.inject({ method: 'GET', url: '/auth/machines/state', headers: { cookie } });
    expect(state.statusCode, state.body).toBe(200);
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id } })).toBe(0);
    const consent = await h.browser('/auth/machines/consent', { approved: true }, cookie, state.json().csrf_token);
    expect(consent.statusCode, consent.body).toBe(200);
    const authority = await h.db.prisma.machineAuthorization.findUniqueOrThrow({ where: { requestId: intent.request_id } });
    expect(authority.personalFactorCompleted).toBe(true); expect(authority.personalFactorAt).not.toBeNull();
    expect(await h.db.prisma.authorizationCode.count({ where: { userId: f.user.id } })).toBe(0);
    expect(await h.db.prisma.refreshToken.count({ where: { userId: f.user.id } })).toBe(0);
  });

  it('replays only the exact original normalized request and does not merge same-named computers', async () => {
    const f = await h.fixture();
    const [a, b] = await Promise.all([f.request(), f.request()]);
    expect(a).toEqual(b);
    const mismatch = await h.api('/authorization-requests', { ...f.input, device_name: 'Other computer' });
    expect(mismatch.statusCode).toBe(409);
    const first = await f.enrolled();
    const second = await f.enrolled({ request_id: randomUUID(), binding_id: randomUUID() });
    expect(first.enrollmentId).not.toBe(second.enrollmentId);
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id, deviceName: f.input.device_name } })).toBe(2);
  });

  it('rejects wrong keys, purpose, audience, unproved requests and unrelated later logins', async () => {
    const f = await h.fixture();
    for (const override of [{ purpose: 'provider_run' }, { audience: 'https://other.example.com' }, { public_key: { ...f.input.public_key, d: 'private' } }]) {
      const result = await h.api('/authorization-requests', { ...f.input, ...override });
      expect(result.statusCode).toBe(400);
    }
    const intent = await f.request();
    const otherKey = generateKeyPairSync('ed25519');
    const wrong = await h.api(`/authorization-requests/${intent.request_id}/proof`, { proof: { challenge_id: intent.challenge_id,
      signature: sign(null, Buffer.from(intent.transcript), otherKey.privateKey).toString('base64url') } });
    expect(wrong.statusCode).toBe(401);
    const unrelated = await f.human();
    expect((await h.browser('/auth/machines/consent', { approved: true }, unrelated.cookie, unrelated.csrf)).statusCode).toBe(401);
    await h.api(`/authorization-requests/${intent.request_id}/proof`, { proof: f.proof(intent) });
    const another = await h.fixture();
    for (const loginToken of [await f.login(), await f.login(intent.request_id, another.user)]) {
      const wrongStart = await h.browser('/auth/machines/start', { login_token: loginToken, organization_id: f.org.id,
        team_id: f.team.id, request_id: intent.request_id });
      expect([401, 403]).toContain(wrongStart.statusCode);
    }
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id } })).toBe(0);
  });

  it('requires exact original grant, person, scope, key and current credential over machine routes', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    for (const override of [{ subject: randomUUID() }, { organization_id: randomUUID() }, { team_id: randomUUID() },
      { audience: 'https://other.example.com' }, { binding_id: randomUUID() }, { authorization_id: randomUUID() },
      { enrollment_id: randomUUID() }, { credential_generation: 2 }, { source_version: '9223372036854775807' },
      { credential: 'uoa_machine_' + 'A'.repeat(43) }]) {
      const result = await h.api('/challenges', { operation: 'validate', request: { ...grant.operation, ...override } });
      expect(result.statusCode, JSON.stringify(override)).toBe(401);
    }
    const missingAppProof = await h.api('/challenges', { operation: 'validate', request: grant.operation }, 'POST', 'wrong');
    expect(missingAppProof.statusCode).toBe(401);
    const valid = await f.operate('validate', grant.operation);
    expect(valid.statusCode, valid.body).toBe(200);
    const decision = MachineDecisionResponse.parse(valid.json().decision);
    expect(decision).toMatchObject({ decision: 'allowed', reason: 'active', original_grant_id: grant.enrollmentId });
    expect(Date.parse(decision.recheck_by) - Date.parse(decision.issued_at)).toBeLessThanOrEqual(30_000);
    expect(valid.headers['cache-control']).toBe('private, no-store');
  });

  it('presents renewal only for the exact existing binding, name and protected key', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const other = await h.fixture();
    for (const changed of [{ binding_id: randomUUID() }, { subject: other.user.id },
      { team_id: randomUUID() }, { public_key: other.input.public_key }, { device_name: 'Another device' }]) {
      const refused = await h.api('/authorization-requests', { ...f.input, ...changed,
        enrollment_id: grant.enrollmentId, request_id: randomUUID() });
      expect(refused.statusCode, refused.body).toBe(401);
    }
    const renewal = await f.request({ enrollment_id: grant.enrollmentId, request_id: randomUUID() });
    expect(renewal.authorization_url).toContain('machine_request_id=');
    expect(await h.db.prisma.machineAuthorization.count({ where: { enrollmentId: grant.enrollmentId } })).toBe(1);
  });

  it('protects persisted originals, denies app-role reads and includes machine consent in deletion evidence', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const authorization = await h.db.prisma.machineAuthorization.findFirstOrThrow({ where: { enrollmentId: grant.enrollmentId } });
    await expect(h.db.prisma.machineAuthorization.update({ where: { id: authorization.id }, data: { credentialEpoch: 500 } })).rejects.toThrow();
    await expect(h.db.prisma.machineEnrollment.update({ where: { id: grant.enrollmentId }, data: { subject: randomUUID() } })).rejects.toThrow();
    await expect(h.db.prisma.machineCredential.deleteMany({ where: { enrollmentId: grant.enrollmentId } })).rejects.toThrow();
    const appDb = new PrismaClient({ datasources: { db: { url: h.db.appDatabaseUrl } } });
    try { expect(await appDb.machineEnrollment.count()).toBe(0); } finally { await appDb.$disconnect(); }
    expect(await retainedEvidence(h.db.prisma, 'USER', f.user.id)).toContainEqual(expect.objectContaining({ model: 'MachineEnrollment', count: 1 }));
    expect(await h.db.prisma.machineAuthorization.findUnique({ where: { id: authorization.id } })).toEqual(authorization);
  });
});
