// Actual Auth HTML/React and UOA routes/DB, with only config and Google HTTP fixtures.
// Explicit local headless evaluation; never included in ordinary tests or CI.
/* global document, innerWidth */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../../API/src/app.js';
import { createTestDb } from '../../API/tests/helpers/test-db.js';
import { createAdminDomain } from '../../API/src/services/domain-secret.service.js';
import { verifyIssuedAccessToken } from '../../API/tests/helpers/access-token.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt }
  from '../../API/tests/helpers/test-config.js';

const origin = 'https://authentication.example.com';
const configUrl = 'https://client.example.com/auth-config';
const callbackUrl = 'https://client.example.com/oauth/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const stage = process.env.UOA_SOCIAL_ENTRY_STAGE ?? 'after';
const output = process.env.UOA_SOCIAL_ENTRY_EVIDENCE ?? 'e2e/artifacts/social-team-entry';
const previousEnv = { ...process.env };
let db, app, browser, source, target, user, domainAuth;

beforeAll(async () => {
  db = await createTestDb();
  if (!db) throw new Error('An isolated UOA test database is required');
  Object.assign(process.env, { DATABASE_URL: db.databaseUrl, DATABASE_ADMIN_URL: db.databaseUrl,
    PUBLIC_BASE_URL: origin, GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret' });
  domainAuth = await createAdminDomain({ domain: 'client.example.com',
    clientSecret: 'browser-team-fixture-client-secret', actorEmail: 'fixture@example.com' }, { prisma: db.prisma });
  user = await db.prisma.user.create({ data: { email: 'member@example.com', userKey: 'member@example.com' } });
  const org = await db.prisma.organisation.create({ data: { domain: 'client.example.com',
    name: 'Browser journey', slug: randomUUID(), ownerId: user.id } });
  await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
  source = await db.prisma.team.create({ data: { orgId: org.id, name: 'Source team', slug: 'source' } });
  target = await db.prisma.team.create({ data: { orgId: org.id, name: 'Target team', slug: 'target' } });
  await db.prisma.teamMember.createMany({ data: [source, target].map(team => ({
    teamId: team.id, userId: user.id, teamRole: 'owner' })) });
  const config = await signTestConfigJwt(baseClientConfigPayload({ enabled_auth_methods: ['google'],
    allow_registration: false, login_flow: { team_selection: 'auto' },
    org_features: { enabled: true, user_needs_team: true } }));
  const configFetch = await createTestConfigFetchHandler(config);
  vi.stubGlobal('fetch', async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-google-access' });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({
      email: 'member@example.com', email_verified: true, name: 'Browser member' });
    return configFetch(input);
  });
  app = await createApp(); await app.ready();
  const playwright = await import(/* @vite-ignore */ pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser = await playwright.chromium.launch({ headless: true });
  await mkdir(`${output}/${stage}`, { recursive: true });
});

afterAll(async () => {
  if (browser) await browser.close();
  if (app) await app.close();
  if (db) await db.cleanup();
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

function entry(teamId, suffix) {
  const query = new URLSearchParams({ config_url: configUrl, redirect_url: callbackUrl,
    code_challenge: challenge, code_challenge_method: 'S256', state: `browser-${suffix}` });
  if (teamId) query.set('team_hint', teamId);
  return `${origin}/auth?${query}`;
}

async function fulfill(route, response) {
  const headers = Object.fromEntries(Object.entries(response.headers)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : String(value)]));
  if (response.statusCode === 302) {
    const targetUrl = new URL(headers.location, origin).href;
    delete headers.location; delete headers['content-length']; delete headers['content-type'];
    delete headers['content-security-policy']; delete headers['content-encoding'];
    return route.fulfill({ status: 200, headers, contentType: 'text/html',
      body: `<!doctype html><script>location.replace(${JSON.stringify(targetUrl).replaceAll('<', '\\u003c')})</script>` });
  }
  return route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
}

it.each([1280, 390])('opens the exact team and preserves the source family at %ipx', async width => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [], results = [];
  let providerRoundtrips = 0, cancelNext = false, holdSelection = false, releaseSelection;
  let selectionStarted;
  page.on('pageerror', error => pageErrors.push(error.message));
  const shot = async name => {
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: `${output}/${stage}/${width}-${name}.png`, fullPage: true });
  };
  await context.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/auth/select-team' && holdSelection) {
      const payload = request.postDataJSON();
      if (payload.teamId === target.id) {
        selectionStarted();
        await new Promise(resolve => { releaseSelection = resolve; });
      }
    }
    const response = await app.inject({ method: request.method(), url: url.pathname + url.search,
      headers: request.headers(), payload: request.postDataBuffer() ?? undefined });
    return fulfill(route, response);
  });
  await context.route('https://accounts.google.com/**', async route => {
    providerRoundtrips++;
    const state = new URL(route.request().url()).searchParams.get('state');
    const next = new URL(`${origin}/auth/callback/google`);
    next.searchParams.set('state', state);
    next.searchParams.set(cancelNext ? 'error' : 'code', cancelNext ? 'access_denied' : 'fixture-provider-code');
    cancelNext = false;
    return route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><script>location.replace(${JSON.stringify(next.href)})</script>` });
  });
  await context.route(`${callbackUrl}**`, async route => {
    const code = new URL(route.request().url()).searchParams.get('code');
    if (!code) return route.fulfill({ contentType: 'text/html', body: '<h1>Provider cancelled</h1>' });
    const token = await app.inject({ method: 'POST', url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      headers: { authorization: `Bearer ${domainAuth.clientHash}` },
      payload: { code, redirect_url: callbackUrl, code_verifier: verifier } });
    expect(token.statusCode, token.body).toBe(200);
    const claims = await verifyIssuedAccessToken(token.json().access_token);
    results.push(claims.active);
    return route.fulfill({ contentType: 'text/html', body: '<h1>Verified product callback</h1><p>Local integration fixture</p>' });
  });
  try {
    // Establish preference only through an actual completed authorization.
    await page.goto(entry(null, `initial-${width}`));
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await page.getByText('Source team', { exact: true }).click();
    await page.getByRole('heading', { name: 'Verified product callback' }).waitFor();
    expect(results[0].teamId).toBe(source.id);
    const sourceFamilies = await db.prisma.refreshToken.findMany({ where: {
      userId: user.id, teamId: source.id, revokedAt: null }, orderBy: { id: 'asc' },
    select: { id: true, orgId: true, teamId: true, revokedAt: true, expiresAt: true, assuranceId: true } });
    await shot('00-source-completed-fixture');
    const started = new Promise(resolve => { selectionStarted = resolve; });
    holdSelection = stage === 'after';
    await page.goto(entry(target.id, `target-${width}`));
    if (stage === 'before') {
      await page.getByRole('link', { name: 'Continue with Google' }).waitFor();
      await shot('01-provider-choice');
      await page.getByRole('link', { name: 'Continue with Google' }).click();
      await page.getByText('Target team', { exact: true }).waitFor();
      await shot('02-team-choice');
      await page.getByText('Target team', { exact: true }).click();
    } else {
      await started;
      expect(await page.getByRole('link', { name: 'Continue with Google' }).count()).toBe(0);
      expect(await page.getByText('Target team', { exact: true }).count()).toBe(0);
      await shot('02-opening-team');
      releaseSelection(); holdSelection = false;
    }
    await page.getByRole('heading', { name: 'Verified product callback' }).waitFor();
    expect(results[1].teamId).toBe(target.id);
    expect(providerRoundtrips).toBe(2);
    expect(await db.prisma.refreshToken.findMany({ where: { id: { in: sourceFamilies.map(row => row.id) } },
      orderBy: { id: 'asc' },
      select: { id: true, orgId: true, teamId: true, revokedAt: true, expiresAt: true, assuranceId: true } }))
      .toEqual(sourceFamilies);
    await shot('03-target-completed-fixture');
    cancelNext = true;
    const cancellation = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/callback/google'
      && response.status() === 401);
    await page.goto(entry(target.id, `cancel-${width}`));
    if (stage === 'before') await page.getByRole('link', { name: 'Continue with Google' }).click();
    await cancellation;
    await page.goto(entry(target.id, `retry-${width}`));
    await page.getByRole('link', { name: 'Continue with Google' }).waitFor();
    expect(providerRoundtrips).toBe(3);
    expect(results).toHaveLength(2);
    await shot('04-cancelled-retry-choice');
    await writeFile(`${output}/${stage}/${width}-results.json`, JSON.stringify({ stage, width,
      targetEntryManualActions: stage === 'before' ? 2 : 0, providerRoundtrips,
      verifiedTarget: true, sourceFamilyUnchanged: true, cancelRequiresChoice: true, pageErrors }, null, 2));
  } finally {
    if (releaseSelection) releaseSelection();
    await context.close();
  }
});
