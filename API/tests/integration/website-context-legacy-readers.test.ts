import { createHash, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { issueAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';
import { exchangeRefreshToken } from '../../src/services/refresh-token.service.js';
import { loadPreBridgeRefreshReader } from '../helpers/pre-bridge-refresh-reader.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt } from '../helpers/test-config.js';

const domain = 'website-rollout.example.com';
const configUrl = `https://${domain}/config`;
const redirectUrl = `https://${domain}/callback`;
const verifier = 'website-rollout-verifier-abcdefghijklmnopqrstuvwxyz';
type Pair = { access_token: string; refresh_token: string };

describe.skipIf(!process.env.DATABASE_URL)('real pre-bridge/current website refresh readers', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let archived: Awaited<ReturnType<typeof loadPreBridgeRefreshReader>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let credential: string, clientId: string;
  const saved = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    WEBSITE_CLIENT_CONTEXT_PHASE: process.env.WEBSITE_CLIENT_CONTEXT_PHASE };
  let ip = 1;
  beforeAll(async () => {
    handle = (await createTestDb())!;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.WEBSITE_CLIENT_CONTEXT_PHASE = 'bridge';
    await disconnectPrisma();
    credential = await seedDomainSecret(handle.prisma, domain);
    clientId = (await handle.prisma.clientDomain.findUniqueOrThrow({ where: { domain } })).id;
    const jwt = await signTestConfigJwt(baseClientConfigPayload({ domain, redirect_urls: [redirectUrl],
      org_features: { enabled: false }, login_flow: { team_selection: 'off', email_code_enabled: false } }));
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
    archived = await loadPreBridgeRefreshReader();
    app = await createApp();
    await app.ready();
  });
  beforeEach(() => { process.env.WEBSITE_CLIENT_CONTEXT_PHASE = 'bridge'; });
  afterAll(async () => {
    await app?.close();
    await disconnectPrisma();
    await archived?.cleanup();
    vi.unstubAllGlobals();
    await handle?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
  });
  function request(path: string, payload: unknown, url = configUrl) {
    return app.inject({ method: 'POST', url: `${path}?config_url=${encodeURIComponent(url)}`,
      remoteAddress: `192.0.2.${ip++}`, headers: { authorization: `Bearer ${credential}` }, payload });
  }
  async function issue() {
    const suffix = randomUUID();
    const user = await handle.prisma.user.create({ data: { email: `${suffix}@example.com`, userKey: suffix } });
    await handle.prisma.domainRole.create({ data: { userId: user.id, domain, role: 'USER' } });
    const code = await issueAuthorizationCode({ userId: user.id, domain, configUrl, redirectUrl,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256',
      rememberMe: true, twoFaCompleted: false, credentialEpoch: 0 }, { prisma: handle.prisma });
    const response = await request('/auth/token', { code: code.code, redirect_url: redirectUrl, code_verifier: verifier });
    expect(response.statusCode).toBe(200);
    return { user, pair: response.json<Pair>() };
  }
  const currentContext = () => ({ clientId, domain, configUrl });
  const oldContext = () => ({ clientId: credential, domain, configUrl });
  const deps = () => ({ prisma: handle.prisma });
  const refresh = (token: string, url = configUrl) => request('/auth/token', { grant_type: 'refresh_token', refresh_token: token }, url);
  const row = (token: string) => handle.prisma.refreshToken.findUniqueOrThrow({ where: {
    tokenHash: hashRefreshToken(token, process.env.SHARED_SECRET!),
  } });

  it('issues stable public JWT IDs while actual old/new readers rotate and replay one legacy family', async () => {
    const { pair } = await issue();
    expect(decodeJwt(pair.access_token).client_id).toBe(clientId);
    expect(JSON.stringify(decodeJwt(pair.access_token)).includes(credential)).toBe(false);
    const source = await row(pair.refresh_token);
    expect(source.clientId === credential).toBe(true);
    const old = await archived.reader.exchangeRefreshToken({ ...oldContext(), refreshToken: pair.refresh_token }, deps());
    const current = await refresh(old.refreshToken);
    expect(current.statusCode).toBe(200);
    const latest = current.json<Pair>();
    expect(decodeJwt(latest.access_token).client_id).toBe(clientId);
    const replay = await archived.reader.exchangeRefreshToken({ ...oldContext(), refreshToken: pair.refresh_token }, deps());
    expect(replay.refreshToken === latest.refresh_token).toBe(true);
    const currentReplay = await refresh(pair.refresh_token);
    expect(currentReplay.statusCode).toBe(200);
    expect(currentReplay.json<Pair>().refresh_token === latest.refresh_token).toBe(true);
    const rows = await handle.prisma.refreshToken.findMany({ where: { familyId: source.familyId } });
    expect(rows).toHaveLength(3);
    expect(rows.every(value => value.clientId === credential)).toBe(true);
  });

  it('keeps website debug grants and independent sessions readable without converting source rows on revoke', async () => {
    const { pair } = await issue();
    const source = await row(pair.refresh_token);
    const issued = await request('/auth/debug-login/issue', { refresh_token: pair.refresh_token });
    expect(issued.statusCode).toBe(200);
    const token = issued.json<{ token: string }>().token;
    const grant = await handle.prisma.debugLoginGrant.findFirstOrThrow({ where: { sourceFamilyId: source.familyId } });
    expect(grant.clientId === credential).toBe(true);
    const redeemed = await request('/auth/debug-login/redeem', { token });
    expect(redeemed.statusCode).toBe(200);
    const independent = redeemed.json<Pair>();
    expect((await row(independent.refresh_token)).familyId).not.toBe(source.familyId);
    expect((await row(independent.refresh_token)).clientId === credential).toBe(true);
    const old = await archived.reader.exchangeRefreshToken({ ...oldContext(), refreshToken: independent.refresh_token }, deps());
    expect((await refresh(old.refreshToken)).statusCode).toBe(200);
    const revoked = await request('/auth/revoke', { refresh_token: pair.refresh_token });
    expect(revoked.statusCode).toBe(200);
    expect((await row(pair.refresh_token)).clientId === credential).toBe(true);
    expect((await handle.prisma.debugLoginGrant.findUniqueOrThrow({ where: { id: grant.id } })).clientId === credential).toBe(true);
    await expect(archived.reader.exchangeRefreshToken({ ...oldContext(), refreshToken: pair.refresh_token }, deps()))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it('refuses legacy stable-mode reads without conversion while the actual old reader can still read them', async () => {
    const { pair } = await issue();
    process.env.WEBSITE_CLIENT_CONTEXT_PHASE = 'stable';
    expect((await refresh(pair.refresh_token)).statusCode).toBe(503);
    const unchanged = await row(pair.refresh_token);
    expect(unchanged.clientId === credential).toBe(true);
    expect(unchanged.replacedByTokenId).toBeNull();
    const old = await archived.reader.exchangeRefreshToken({ ...oldContext(), refreshToken: pair.refresh_token }, deps());
    expect((await refresh(old.refreshToken)).statusCode).toBe(503);
    expect((await row(old.refreshToken)).clientId === credential).toBe(true);
  });

  it('lets the reviewed bridge reader consume stable rows while the actual pre-bridge reader refuses them', async () => {
    process.env.WEBSITE_CLIENT_CONTEXT_PHASE = 'stable';
    const { pair } = await issue();
    expect((await row(pair.refresh_token)).clientId).toBe(clientId);
    await expect(archived.reader.exchangeRefreshToken({ ...oldContext(), refreshToken: pair.refresh_token }, deps()))
      .rejects.toMatchObject({ statusCode: 401 });
    expect((await row(pair.refresh_token)).replacedByTokenId).toBeNull();
    process.env.WEBSITE_CLIENT_CONTEXT_PHASE = 'bridge';
    expect((await refresh(pair.refresh_token)).statusCode).toBe(200);
  });

  it('rejects exact config/domain mismatches and revoked pairing without consuming the legacy row', async () => {
    const { pair } = await issue();
    expect((await refresh(pair.refresh_token, `${configUrl}?other=1`)).statusCode).toBe(401);
    await expect(archived.reader.exchangeRefreshToken({ ...oldContext(), configUrl: `${configUrl}?other=1`, refreshToken: pair.refresh_token }, deps()))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(exchangeRefreshToken({ ...currentContext(), domain: 'other.example.com', refreshToken: pair.refresh_token }, deps()))
      .rejects.toMatchObject({ statusCode: 401 });
    await handle.prisma.clientDomainSecret.updateMany({ where: { clientDomainId: clientId }, data: { active: false } });
    expect((await refresh(pair.refresh_token)).statusCode).toBe(401);
    await expect(exchangeRefreshToken({ ...currentContext(), refreshToken: pair.refresh_token }, deps()))
      .rejects.toMatchObject({ statusCode: 401 });
    const unchanged = await row(pair.refresh_token);
    expect(unchanged.replacedByTokenId).toBeNull();
    expect(unchanged.clientId === credential).toBe(true);
  });
});
