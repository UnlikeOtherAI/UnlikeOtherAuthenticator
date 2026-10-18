import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createApp } from '../../API/src/app.js';
import { createTestDb } from '../../API/tests/helpers/test-db.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt } from '../../API/tests/helpers/test-config.js';
import { hashPassword } from '../../API/src/services/password.service.js';
import { encryptTwoFaSecret } from '../../API/src/utils/twofa-secret.js';
import { computeTotp } from '../../API/tests/helpers/totp.js';

// Deliberate test-only personal factor; never a real person's credential.
const factor = 'JBSWY3DPEHPK3PXP';
const password = 'Test-only-personal1!';
const orgId = `browser-${randomUUID()}`;
const userId = `browser-${randomUUID()}`;
let db;
let app;
let origin;
let browser;

beforeAll(async () => {
  const handle = await createTestDb();
  if (!handle) throw new Error('An isolated UOA PostgreSQL test database is required');
  db = handle;
  process.env.DATABASE_URL = db.databaseUrl;
  delete process.env.DATABASE_ADMIN_URL;
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:5198';
  process.env.ADMIN_AUTH_DOMAIN = 'admin.example.com';
  process.env.ADMIN_CONFIG_JWT = await signTestConfigJwt(baseClientConfigPayload({
    domain: 'admin.example.com',redirect_urls: ['http://127.0.0.1:5198/admin/auth/callback'],
    enabled_auth_methods: ['google'],allow_registration: false,
  }));
  await db.prisma.clientDomain.create({ data: { domain: 'client.example.com', label: 'Browser fixture' } });
  await db.prisma.user.create({ data: { id: userId, email: 'owner@example.com', userKey: 'owner@example.com',
    passwordHash: await hashPassword(password), twoFaEnabled: true, twoFaSecret: encryptTwoFaSecret({secret: factor,sharedSecret: process.env.SHARED_SECRET ?? ''}) } });
  await db.prisma.organisation.create({ data: { id: orgId, domain: 'client.example.com',
    name: 'Acme browser journey', slug: orgId, ownerId: userId } });
  await db.prisma.orgMember.create({ data: { orgId, userId, role: 'owner' } });
  const team = await db.prisma.team.create({ data: { orgId, name: 'Only team', slug: 'only-team' } });
  await db.prisma.teamMember.create({ data: { teamId: team.id, userId, teamRole: 'owner' } });
  const jwt = await signTestConfigJwt(baseClientConfigPayload({ '2fa_enabled': false, login_flow: { team_selection: 'auto' } }));
  vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
  app = await createApp();
  origin = await app.listen({ host: '127.0.0.1', port: 5198 });
  const playwright = await import(/* @vite-ignore */ pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? '').href);
  browser = await playwright.chromium.launch({ headless: true });
  await mkdir('e2e/artifacts/management-browser', { recursive: true });
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await db?.cleanup();
  vi.unstubAllGlobals();
});

it('keeps a one-team owner in management and completes personal TOTP into browser-bound settings', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const query = new URLSearchParams({ config_url: 'https://client.example.com/auth-config',
    flow: 'organisation_management', management_org_id: orgId, code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256', state: 'b'.repeat(43) });
  await page.goto(`${origin}/auth?${query}`);
  await page.locator('input[name=email]').fill('owner@example.com');
  await page.locator('input[name=password]').fill(password);
  await page.locator('button[type=submit]').click();
  await expect.poll(() => page.getByText('Acme browser journey', { exact: false }).count()).toBe(1);
  expect(await page.getByText('Only team', { exact: true }).count()).toBe(0);
  await page.screenshot({ path: 'e2e/artifacts/management-browser/390-owner-choice.png', fullPage: true });
  const responsePromise = page.waitForResponse((response) => response.url().includes('/organisation-access/start'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const start = await responsePromise;
  expect(start.status()).toBe(200);
  expect((await start.json()).twofa_required).toBe(true);
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name === 'uoa_management_intent' && cookie.httpOnly)).toBe(true);
  await page.locator('input[name=code]').fill(computeTotp({secret: factor,nowMs: Date.now()}));
  const documentPromise = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/organisation-access');
  const exchangeRequestPromise = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/organisation-access/exchange');
  const exchangePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/organisation-access/exchange');
  const verifyPromise = page.waitForResponse(response => response.url().includes('/2fa/verify'));
  await page.locator('button[type=submit]').click();
  const verified = await verifyPromise;
  expect(verified.status()).toBe(200);
  await page.waitForURL('**/auth/organisation-access**');
  expect((await documentPromise).status()).toBe(200);
  expect((await exchangePromise).status()).toBe(200);
  await page.screenshot({path:'e2e/artifacts/management-browser/390-arrival.png',fullPage:true});
  await expect.poll(() => page.getByText('Acme browser journey', { exact: false }).count()).toBeGreaterThan(0);
  expect(new URL(page.url()).hash).toBe('');
  const foreign = await browser.newContext();
  const denied = await foreign.request.post(`${origin}/auth/organisation-access/exchange`, {
    data: (await exchangeRequestPromise).postDataJSON(),headers: {origin},
  });
  expect(denied.status()).toBe(403);
  await foreign.close();
  await page.reload();
  await expect.poll(() => page.getByText('Acme browser journey', {exact:false}).count()).toBeGreaterThan(0);
  expect(await db.prisma.authorizationCode.count({ where: { userId } })).toBe(0);
  expect(await db.prisma.refreshToken.count({ where: { userId } })).toBe(0);
  await page.screenshot({ path: 'e2e/artifacts/management-browser/390-settings.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'e2e/artifacts/management-browser/1280-settings.png', fullPage: true });
  await context.close();
});
