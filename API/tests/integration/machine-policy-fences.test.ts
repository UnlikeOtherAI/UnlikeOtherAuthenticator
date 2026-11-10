import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { machineHarness, machineConfigUrl, machineDomain, type MachineHarness } from '../helpers/machine-fixture.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { issueSessionAssurance, validateSessionAssurance } from '../../src/services/session-assurance.service.js';
import { getAdminPrisma } from '../../src/db/prisma.js';
import { historicalMachine } from '../helpers/machine-history-fixture.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';

describe('machine v1 canonical security and membership fences', () => {
  let h: MachineHarness;
  beforeAll(async () => { h = await machineHarness(); });
  afterAll(async () => { await h?.cleanup(); });
  function auth(path: string, payload: unknown) {
    return h.app.inject({ method: 'POST', url: path + '?' + new URLSearchParams({ config_url: machineConfigUrl, domain: machineDomain }),
      headers: { authorization: `Bearer ${h.bearer}` }, payload });
  }
  async function family(f: Awaited<ReturnType<MachineHarness['fixture']>>) {
    return issueRefreshToken({ userId: f.user.id, domain: machineDomain, configUrl: machineConfigUrl,
      clientId: h.bearer, orgId: f.org.id, teamId: f.team.id, twoFaCompleted: false }, { prisma: h.db.prisma });
  }

  it('ordinary real refresh/family logout preserves machine authority; omitted-scope global revoke fences it', async () => {
    const f = await h.fixture(); const grant = await f.enrolled(); const original = await family(f);
    const refresh = await auth('/auth/token', { grant_type: 'refresh_token', refresh_token: original.refreshToken });
    expect(refresh.statusCode, refresh.body).toBe(200);
    const logout = await auth('/auth/revoke', { refresh_token: refresh.json().refresh_token, scope: 'family' });
    expect(logout.statusCode, logout.body).toBe(200);
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).tokenVersion).toBe(f.user.tokenVersion);
    expect((await f.operate('validate', grant.operation)).json().decision.decision).toBe('allowed');
    const other = await family(f);
    expect((await auth('/auth/revoke', { refresh_token: other.refreshToken })).statusCode).toBe(200);
    const reset = await f.operate('validate', { ...grant.operation, request_id: randomUUID() });
    expect(reset.json().decision).toMatchObject({ decision: 'revoked', reason: 'security_reset', source_version: '2' });
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).tokenVersion).toBe(f.user.tokenVersion + 1);
  });

  it('a fresh human reauthorization appends a linked event while old authority cannot revoke or validate it', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const original = await h.db.prisma.machineAuthorization.findUniqueOrThrow({ where: { id: grant.operation.authorization_id } });
    const oldRevoke = await f.prepare('revoke', { ...grant.operation, request_id: randomUUID() });
    await h.db.prisma.user.update({ where: { id: f.user.id }, data: { tokenVersion: { increment: 1 } } });
    const renewed = await f.enrolled({ request_id: randomUUID(), enrollment_id: grant.enrollmentId });
    expect(renewed.enrollmentId).toBe(grant.enrollmentId);
    expect(renewed.operation).toMatchObject({ credential_generation: 2, source_version: '3' });
    expect(renewed.operation.authorization_id).not.toBe(original.id);
    const current = await h.db.prisma.machineAuthorization.findUniqueOrThrow({ where: { id: renewed.operation.authorization_id } });
    expect(current.predecessorId).toBe(original.id);
    expect(await h.db.prisma.machineAuthorization.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect((await h.api('/enrollments/revoke', oldRevoke)).statusCode).toBe(401);
    expect((await f.operate('validate', renewed.operation)).json().decision.decision).toBe('allowed');
  });

  it('owner exact-device and all-team retirement are idempotent and do not revive through fresh transport', async () => {
    const f = await h.fixture(); const one = await f.enrolled();
    const two = await f.enrolled({ request_id: randomUUID(), binding_id: randomUUID() });
    const session = await f.human();
    const revoke = () => h.browser(`/auth/machines/${one.enrollmentId}/revoke`, {}, session.cookie, session.csrf);
    expect((await revoke()).statusCode).toBe(200); expect((await revoke()).statusCode).toBe(200);
    expect((await f.operate('validate', one.operation)).json().decision).toMatchObject({ decision: 'revoked', reason: 'device_revoked', source_version: '2' });
    expect((await f.operate('validate', two.operation)).json().decision.decision).toBe('allowed');
    expect((await h.browser('/auth/machines/all/revoke', {}, session.cookie, session.csrf)).statusCode).toBe(200);
    expect((await f.operate('validate', { ...two.operation, request_id: randomUUID() })).json().decision.reason).toBe('all_devices_revoked');
    const blocked = await h.api('/authorization-requests', { ...f.input, request_id: randomUUID(), enrollment_id: one.enrollmentId });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().code).toBe('MACHINE_NEW_GRANT_REQUIRED');
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).tokenVersion).toBe(f.user.tokenVersion);
  });

  it('team removal/re-add stops the exact affected grant and leaves another team connection live', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const otherTeam = await h.db.prisma.team.create({ data: { orgId: f.org.id, name: 'Fictional other team', slug: 'other' } });
    await h.db.prisma.teamMember.create({ data: { teamId: otherTeam.id, userId: f.user.id } });
    const unaffected = await f.enrolled({ request_id: randomUUID(), binding_id: randomUUID(), team_id: otherTeam.id });
    await h.db.prisma.teamMember.delete({ where: { teamId_userId: { teamId: f.team.id, userId: f.user.id } } });
    await h.db.prisma.teamMember.create({ data: { teamId: f.team.id, userId: f.user.id } });
    const result = await f.operate('validate', grant.operation);
    expect(result.json().decision).toMatchObject({ decision: 'access_removed', reason: 'access_removed', source_version: '2' });
    expect((await f.operate('validate', unaffected.operation)).json().decision.decision).toBe('allowed');
  });

  it('product disable/re-enable leaves existing approvals stopped and does not increment the human epoch', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    await h.db.prisma.billingService.update({ where: { id: h.service.id }, data: { active: false } });
    await h.db.prisma.billingService.update({ where: { id: h.service.id }, data: { active: true } });
    expect((await f.operate('validate', grant.operation)).json().decision).toMatchObject({ decision: 'revoked', reason: 'product_disabled' });
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).tokenVersion).toBe(f.user.tokenVersion);
  });

  it('SSO generation and personal-factor policy changes publish durable, typed reauthorization fences', async () => {
    const f = await h.fixture();
    await h.db.prisma.orgSsoPolicy.create({ data: { clientDomain: machineDomain, orgId: f.org.id } });
    const grant = await f.enrolled();
    await h.db.prisma.orgSsoPolicy.update({ where: { clientDomain_orgId: { clientDomain: machineDomain, orgId: f.org.id } }, data: { generation: { increment: 1 } } });
    expect((await f.operate('validate', grant.operation)).json().decision).toMatchObject({ decision: 'reauthorization_required', reason: 'sso_policy_changed' });
    const other = await h.fixture(); const second = await other.enrolled();
    await h.db.prisma.organisation.update({ where: { id: other.org.id }, data: { twoFaPolicy: 'REQUIRED' } });
    await h.db.prisma.organisation.update({ where: { id: other.org.id }, data: { twoFaPolicy: null } });
    expect((await other.operate('validate', second.operation)).json().decision).toMatchObject({ decision: 'reauthorization_required', reason: 'authentication_policy_changed' });
  });

  it('enabling the canonical personal factor fences prior consent without a global reset or automatic revival on disable', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const original = await h.db.prisma.machineAuthorization.findUniqueOrThrow({ where: { id: grant.operation.authorization_id } });
    await h.db.prisma.user.update({ where: { id: f.user.id }, data: { twoFaEnabled: true,
      twoFaSecret: encryptTwoFaSecret({ secret: 'JBSWY3DPEHPK3PXP', sharedSecret: process.env.SHARED_SECRET! }) } });
    // Inspect before validation: the SOURCE transaction, not a lazy admission
    // check, must have committed the fence using users."2fa_enabled".
    expect(await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: grant.enrollmentId } }))
      .toMatchObject({ status: 'reauthorization_required', reason: 'authentication_policy_changed', sourceVersion: 2n });
    await h.db.prisma.user.update({ where: { id: f.user.id }, data: { twoFaEnabled: false } });
    const result = await f.operate('validate', grant.operation);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().decision).toMatchObject({ decision: 'reauthorization_required',
      reason: 'authentication_policy_changed', source_version: '2' });
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).tokenVersion).toBe(f.user.tokenVersion);
    expect(await h.db.prisma.machineAuthorization.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });

  it('SCIM deactivation/re-add fences the original SSO authorization even when manual membership survives', async () => {
    const f = await h.fixture();
    const policy = await h.db.prisma.orgSsoPolicy.create({ data: { clientDomain: machineDomain, orgId: f.org.id, arrangementEnabled: true } });
    const connection = await h.db.prisma.orgSsoConnection.create({ data: { clientDomain: machineDomain, orgId: f.org.id,
      preset: 'other_oidc', protocol: 'oidc', displayName: 'Fictional enterprise', status: 'active', testedRevision: 1, configuration: {} } });
    const identity = await h.db.prisma.externalIdentity.create({ data: { clientDomain: machineDomain, orgId: f.org.id,
      userId: f.user.id, connectionId: connection.id, issuer: 'https://enterprise.example.com', tenant: 'fictional-tenant',
      subject: 'fictional-external-subject', identityScope: 'global', linkedVia: 'explicit_link' } });
    const grant = await historicalMachine(h, f, { enterprise: { connectionId: connection.id, identityId: identity.id,
      connectionRevision: connection.revision, connectionGeneration: connection.generation, policyGeneration: policy.generation } });
    const resource = await h.db.prisma.scimResourceLink.create({ data: { connectionId: connection.id, clientDomain: machineDomain,
      orgId: f.org.id, resourceType: 'Users', subjectBinding: identity.id, userId: f.user.id, attributes: {}, active: true } });
    expect((await f.operate('validate', grant.operation)).json().decision.decision).toBe('allowed');
    await h.db.prisma.scimResourceLink.update({ where: { id: resource.id }, data: { active: false, version: { increment: 1 } } });
    await h.db.prisma.scimResourceLink.update({ where: { id: resource.id }, data: { active: true, version: { increment: 1 } } });
    expect(await h.db.prisma.teamMember.findUnique({ where: { teamId_userId: { teamId: f.team.id, userId: f.user.id } } })).toBeTruthy();
    expect((await f.operate('validate', { ...grant.operation, request_id: randomUUID() })).json().decision)
      .toMatchObject({ decision: 'reauthorization_required', reason: 'sso_policy_changed', source_version: '2' });
  });

  it('explicit legacy adoption links only the exact stale original without rewriting or validating its human authority', async () => {
    const f = await h.fixture(); const source = await family(f);
    const row = await h.db.prisma.refreshToken.findUniqueOrThrow({ where: { id: source.refreshTokenId } });
    const issued = await issueSessionAssurance({ userId: f.user.id, clientDomain: machineDomain, orgId: f.org.id, teamId: f.team.id,
      credentialEpoch: f.user.tokenVersion, familyId: row.familyId, method: 'independent', observedAt: new Date(),
      authenticatedAt: new Date(), mfaSource: 'none', amr: ['email_password'], expiresAt: new Date(Date.now() + 3_600_000) }, h.db.prisma);
    const binding = { id: issued.assurance.id, userId: f.user.id, clientDomain: machineDomain, orgId: f.org.id, teamId: f.team.id, credentialEpoch: f.user.tokenVersion };
    await h.db.prisma.user.update({ where: { id: f.user.id }, data: { tokenVersion: { increment: 1 } } });
    await expect(validateSessionAssurance(binding, h.db.prisma)).rejects.toMatchObject({ statusCode: 401 });
    const before = await h.db.prisma.sessionAssurance.findUniqueOrThrow({ where: { id: issued.assurance.id } });
    const other = await h.fixture(); const otherFamily = await family(other);
    const otherRow = await h.db.prisma.refreshToken.findUniqueOrThrow({ where: { id: otherFamily.refreshTokenId } });
    const unrelated = await issueSessionAssurance({ userId: other.user.id, clientDomain: machineDomain, orgId: other.org.id, teamId: other.team.id,
      credentialEpoch: other.user.tokenVersion, familyId: otherRow.familyId, method: 'independent', observedAt: new Date(),
      authenticatedAt: new Date(), mfaSource: 'none', amr: ['email_password'], expiresAt: new Date(Date.now() + 3_600_000) }, h.db.prisma);
    const wrong = await f.request({ request_id: randomUUID(), legacy_assurance_id: unrelated.assurance.id });
    await h.api(`/authorization-requests/${wrong.request_id}/proof`, { proof: f.proof(wrong) });
    const wrongSession = await f.human(wrong.request_id);
    expect((await h.browser('/auth/machines/consent', { approved: true }, wrongSession.cookie, wrongSession.csrf)).statusCode).toBe(401);
    const adopted = await f.enrolled({ legacy_assurance_id: issued.assurance.id });
    expect(await h.db.prisma.machineAuthorization.findUniqueOrThrow({ where: { id: adopted.operation.authorization_id } })).toMatchObject({ legacyAssuranceId: issued.assurance.id, credentialEpoch: f.user.tokenVersion + 1 });
    expect(await h.db.prisma.sessionAssurance.findUniqueOrThrow({ where: { id: issued.assurance.id } })).toEqual(before);
    await expect(validateSessionAssurance(binding, h.db.prisma)).rejects.toMatchObject({ statusCode: 401 });
    expect(await validateSessionAssurance({ id: unrelated.assurance.id, userId: other.user.id, clientDomain: machineDomain,
      orgId: other.org.id, teamId: other.team.id, credentialEpoch: other.user.tokenVersion }, h.db.prisma)).toEqual(unrelated.assurance);
    expect((await f.operate('validate', adopted.operation)).json().decision.decision).toBe('allowed');
  });

  it('returns a separate HTTP 503 outcome without fabricated authority or payload diagnostics', async () => {
    const f = await h.fixture(); const grant = await f.enrolled(); const prepared = await f.prepare('validate', grant.operation);
    const failure = vi.spyOn(getAdminPrisma(), '$transaction').mockRejectedValueOnce(new Error('private-bound-credential-should-never-escape'));
    try {
      const unavailable = await h.api('/enrollments/validate', prepared);
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ decision: 'unavailable', reason: 'authority_unavailable' });
      expect(unavailable.body).not.toContain(grant.operation.credential);
      expect(unavailable.body).not.toContain('private-bound-credential');
    } finally { failure.mockRestore(); }
    expect((await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: grant.enrollmentId } })).status).toBe('allowed');
  });
});
