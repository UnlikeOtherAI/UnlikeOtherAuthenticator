import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { hashPassword } from '../../src/services/password.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { MachineBinding, MachineRequestInput, type MachineOperation } from '../../src/services/machine-contract.js';
import { createRlsTestDb } from './test-db.js';
import { seedDomainSecret } from './domain-secret.js';
import { baseClientConfigPayload, signTestConfigJwt, createTestConfigFetchHandler, testConfigJwks } from './test-config.js';

export const machineDomain = 'machine.example.com';
export const machineOrigin = 'https://auth.example.com';
export const machineConfigUrl = `https://${machineDomain}/config`;
const verifier = 'machine-human-test-verifier-abcdefghijklmnopqrstuvwxyz';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const password = 'Fictional-machine-human-password-2026';
export async function machineHarness() {
  const db = await createRlsTestDb(); if (!db) throw new Error('Real isolated PostgreSQL DATABASE_URL required');
  const envKeys = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'PUBLIC_BASE_URL', 'ADMIN_AUTH_DOMAIN', 'ADMIN_CONFIG_JWT'];
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let closeApp: (() => Promise<unknown>) | undefined;
  try {
  process.env.DATABASE_URL = db.appDatabaseUrl; process.env.DATABASE_ADMIN_URL = db.adminDatabaseUrl;
  process.env.PUBLIC_BASE_URL = machineOrigin; process.env.ADMIN_AUTH_DOMAIN = 'admin.example.com';
  const config = validateConfigFields(baseClientConfigPayload({ domain: machineDomain,
    redirect_urls: [`https://${machineDomain}/callback`], enabled_auth_methods: ['email_password'],
    '2fa_enabled': false, allow_registration: false, org_features: { enabled: true }, login_flow: { team_selection: 'auto' } }));
  const jwt = await signTestConfigJwt(config);
  process.env.ADMIN_CONFIG_JWT = await signTestConfigJwt(baseClientConfigPayload({ domain: 'admin.example.com',
    enabled_auth_methods: ['google'], allow_registration: false, redirect_urls: [`${machineOrigin}/admin/auth/callback`] }));
  const fetchConfig = await createTestConfigFetchHandler({ [machineConfigUrl]: jwt });
  vi.stubGlobal('fetch', vi.fn(fetchConfig));
  const bearer = await seedDomainSecret(db.prisma, machineDomain);
  const service = await db.prisma.billingService.create({ data: { identifier: 'nessie', name: 'Fictional Nessie' } });
  const publicJwk = (await testConfigJwks()).keys[0];
  await db.prisma.billingAppKey.create({ data: { serviceId: service.id, purpose: 'CUSTOMER_LIFECYCLE',
    name: 'Machine test mapping', keyPrefix: 'fixture', secretDigest: createHash('sha256').update(randomUUID()).digest('hex'), actorIssuer: `https://${machineDomain}`,
    actorAudience: machineOrigin, actorKeyId: 'fixture', actorPublicJwk: publicJwk as Prisma.InputJsonValue,
    checkoutReturnOrigins: [`https://${machineDomain}`] } });
  await disconnectPrisma(); const app = await createApp(); closeApp = () => app.close(); await app.ready();
  let ip = 1;
  function api(path: string, payload: unknown = {}, method: 'GET' | 'POST' = 'POST', token = bearer) {
    return app.inject({ method, remoteAddress: `192.0.2.${(ip++ % 240) + 1}`,
      url: `/machine/v1${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ domain: machineDomain, config_url: machineConfigUrl })}`,
      headers: { authorization: `Bearer ${token}` }, ...(method === 'POST' ? { payload } : {}) });
  }
  function browser(path: string, payload: unknown, cookie?: string, csrf?: string, origin = machineOrigin) {
    return app.inject({ method: 'POST', remoteAddress: `198.51.100.${(ip++ % 240) + 1}`,
      url: `${path}?config_url=${encodeURIComponent(machineConfigUrl)}`,
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-uoa-csrf': csrf } : {}) }, payload });
  }
  async function fixture() {
    const id = randomUUID();
    const ownerEmail = `owner-${id}@example.test`, userEmail = `${id}@example.test`;
    const owner = await db!.prisma.user.create({ data: { userKey: ownerEmail, email: ownerEmail } });
    const user = await db!.prisma.user.create({ data: { userKey: userEmail, email: userEmail, passwordHash: await hashPassword(password) } });
    await db!.prisma.domainRole.create({ data: { userId: user.id, domain: machineDomain, role: 'USER' } });
    const org = await db!.prisma.organisation.create({ data: { name: 'Fictional Studio', slug: `studio-${id}`, domain: machineDomain, ownerId: owner.id } });
    await db!.prisma.orgMember.createMany({ data: [{ orgId: org.id, userId: owner.id, role: 'owner' }, { orgId: org.id, userId: user.id, role: 'member' }] });
    const team = await db!.prisma.team.create({ data: { orgId: org.id, name: 'Fictional Design', slug: 'design', isDefault: true } });
    await db!.prisma.teamMember.create({ data: { teamId: team.id, userId: user.id } });
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ format: 'jwk' });
    const input = { subject: user.id, audience: `https://${machineDomain}`, organization_id: org.id, team_id: team.id,
      purpose: 'computer_connection' as const, binding_id: randomUUID(), request_id: randomUUID(),
      device_name: 'Fictional studio computer', public_key: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: publicKey.x! } };
    const intentUrls = new Map<string,string>();
    const intentScopes = new Map<string, { organization_id: string; team_id: string }>();
    // Adversarial fixture input only, never a native broker's signing interface.
    // The native contract validates its locally expected typed context and digest first.
    const proof = (value: { challenge_id: string; transcript: string }) => ({ challenge_id: value.challenge_id,
      signature: sign(null, Buffer.from(value.transcript), keys.privateKey).toString('base64url') });
    async function login(requestId?: string, person = user) {
      const intentUrl = requestId ? new URL(intentUrls.get(requestId)!) : null;
      const auth = await app.inject({ method: 'POST', remoteAddress: `203.0.113.${(ip++ % 240) + 1}`,
        url: '/auth/login?' + new URLSearchParams({ config_url: machineConfigUrl, machine_management: 'true',
          ...(requestId ? { machine_request_id: requestId, state: requestId } : {}),
          code_challenge: intentUrl?.searchParams.get('code_challenge') ?? challenge, code_challenge_method: 'S256' }),
        payload: { email: person.email, password } });
      expect(auth.statusCode, auth.body).toBe(200);
      const loginToken = auth.json<{ login_token: string }>().login_token; expect(loginToken).toBeTruthy();
      return loginToken;
    }
    async function human(requestId?: string, person = user) {
      const loginToken = await login(requestId, person);
      const scope = (requestId ? intentScopes.get(requestId) : undefined) ?? { organization_id: org.id, team_id: team.id };
      const start = await browser('/auth/machines/start', { login_token: loginToken, ...scope,
        ...(requestId ? { request_id: requestId } : {}) });
      expect(start.statusCode, start.body).toBe(200);
      const cookie = String(start.headers['set-cookie']).split(';')[0];
      const state = await app.inject({ method: 'GET', url: '/auth/machines/state', headers: { cookie } });
      expect(state.statusCode, state.body).toBe(200);
      return { cookie, csrf: state.json<{ csrf_token: string }>().csrf_token, state: state.json(), start };
    }
    async function request(overrides: Record<string, unknown> = {}) {
      const result = await api('/authorization-requests', { ...input, ...overrides });
      expect(result.statusCode, result.body).toBe(200);
      const intent = result.json<{ request_id: string; challenge_id: string; transcript: string; authorization_url: string }>();
      intentUrls.set(intent.request_id,intent.authorization_url);
      const binding = MachineBinding.strip().parse({ ...input, ...overrides });
      intentScopes.set(intent.request_id, { organization_id: binding.organization_id, team_id: binding.team_id }); return intent;
    }
    async function approve(overrides: Record<string, unknown> = {}) {
      const requestInput = MachineRequestInput.parse({ ...input, ...overrides });
      const intent = await request(overrides);
      const possession = await api(`/authorization-requests/${intent.request_id}/proof`, { proof: proof(intent) });
      expect(possession.statusCode, possession.body).toBe(200);
      const session = await human(intent.request_id);
      const consent = await browser('/auth/machines/consent', { approved: true }, session.cookie, session.csrf);
      expect(consent.statusCode, consent.body).toBe(200);
      const operationId = intent.request_id;
      return { intent, requestInput, session, consent, operationId, enrollmentId: consent.json<{ enrollment_id: string }>().enrollment_id };
    }
    async function recover(operationId: string, binding = MachineBinding.strip().parse(input)) {
      const request = { ...MachineBinding.strip().parse(binding), request_id: randomUUID(), operation_id: operationId };
      const issued = await api('/recovery/challenge', request); expect(issued.statusCode, issued.body).toBe(200);
      const value = issued.json<{ challenge_id: string; transcript: string }>();
      const result = await api('/recovery', { ...request, proof: proof(value) });
      return { result, request, challenge: value };
    }
    async function enrolled(overrides: Record<string, unknown> = {}) {
      const grant = await approve(overrides); const binding = MachineBinding.strip().parse(grant.requestInput);
      const recovered = await recover(grant.operationId, binding);
      expect(recovered.result.statusCode, recovered.result.body).toBe(200);
      const issued = recovered.result.json<{ credential: string; original_grant_id: string; authorization_id: string; credential_generation: number; source_version: string }>();
      const operation: MachineOperation = { ...binding, request_id: randomUUID(),
        enrollment_id: issued.original_grant_id, authorization_id: issued.authorization_id,
        credential_generation: issued.credential_generation, source_version: issued.source_version, credential: issued.credential };
      return { ...grant, operation, recovered: issued };
    }
    async function prepare(kind: 'validate' | 'rotate' | 'revoke', value: MachineOperation) {
      const issued = await api('/challenges', { operation: kind, request: value });
      expect(issued.statusCode, issued.body).toBe(200);
      const challenge = issued.json<{ challenge_id: string; transcript: string }>();
      return { ...value, proof: proof(challenge) };
    }
    async function operate(kind: 'validate' | 'rotate' | 'revoke', value: MachineOperation) {
      return api(`/enrollments/${kind}`, await prepare(kind, value));
    }
    return { user, owner, org, team, keys, input, proof, login, human, request, approve, recover, enrolled, prepare, operate };
  }
  return { db, app, config, bearer, service, api, browser, fixture,
    cleanup: async () => { await app.close(); await disconnectPrisma(); await db.cleanup(); vi.unstubAllGlobals();
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value; } } };
  } catch (error) {
    if (closeApp) await closeApp().catch(() => undefined);
    await disconnectPrisma().catch(() => undefined);
    // Preserve the failed schema for audit; close only this fixture's clients.
    await db.prisma.$disconnect().catch(() => undefined);
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value; }
    throw error;
  }
}
export type MachineHarness = Awaited<ReturnType<typeof machineHarness>>;
