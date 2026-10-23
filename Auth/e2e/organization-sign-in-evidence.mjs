// Local headless journey. Run with API's tsx loader; never part of CI.
/* global window, document, innerWidth */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSessionChoices } from '../../API/src/services/session-choices.service.ts';
import { validateConfigFields } from '../../API/src/services/config.service.ts';
import { baseClientConfigPayload } from '../../API/tests/helpers/test-config.ts';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const before = await import(pathToFileURL(resolve(process.env.UOA_BEFORE_ROOT,
  'API/src/services/session-choices.service.ts')).href);
const output = process.env.UOA_SCREENSHOTS ?? 'Docs/evidence/organization-sign-in';
const configUrl = 'https://api.nessie.works/api/auth/sso/config?organizationId=kilomayo';
const redirectUrl = 'https://app.nessie.works/login';
const config = validateConfigFields({ ...baseClientConfigPayload(),
  domain: 'api.nessie.works', redirect_urls: [redirectUrl], enabled_auth_methods: ['google', 'email_password'],
  allow_registration: false, login_flow: { team_selection: 'auto', organization_id: 'kilomayo' },
  org_features: { enabled: true, allow_user_create_org: true, allow_user_create_team: true },
});
const names = { kilomayo: 'KiloMayo', elsewhere: 'Another organization' };
function directory(scenario) {
  const orgs = scenario === 'empty' ? ['elsewhere'] : ['kilomayo', 'elsewhere'];
  const rows = orgs.flatMap(orgId => (scenario === 'single' ? ['Research'] : ['Research', 'Operations'])
    .map(name => ({ teamId: `${orgId}-${name}`, teamRole: scenario === 'single' ? 'member' : 'owner',
      team: { orgId, name: orgId === 'kilomayo' ? name : `Other ${name}`, slug: name.toLowerCase(),
        iconUrl: null, updatedAt: new Date(), org: { name: names[orgId] } } })));
  return {
    user: { findUnique: async () => ({ email: 'member@example.test' }), findMany: async () => [] },
    teamMember: { findMany: async ({ where }) => rows.filter(row => !where.team.orgId || row.team.orgId === where.team.orgId) },
    orgMember: { findMany: async ({ where }) => scenario === 'single' ? [] : orgs
      .filter(orgId => !where.orgId || orgId === where.orgId)
      .map(orgId => ({ orgId, role: 'owner', org: { name: names[orgId] } })) },
    teamInvite: { findMany: async ({ where }) => scenario === 'single' || scenario === 'empty' ? [] : orgs
      .filter(orgId => !where.orgId || orgId === where.orgId)
      .map(orgId => ({ id: `invite-${orgId}`, team: { name: `${names[orgId]} Design` },
        org: { name: names[orgId] }, invitedByName: 'Jo', invitedByUserId: null })) },
  };
}
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge' });
try {
  for (const [stage, origin, build] of [
    ['before', process.env.UOA_AUTH_PREVIEW_BEFORE ?? 'http://127.0.0.1:5199', before.buildSessionChoices],
    ['after', process.env.UOA_AUTH_PREVIEW_AFTER ?? 'http://127.0.0.1:5198', buildSessionChoices],
  ]) {
    await mkdir(`${output}/${stage}`, { recursive: true });
    for (const width of [1280, 390]) {
      for (const scenario of ['multiple', 'empty', 'single']) {
        const prisma = directory(scenario);
        const choices = await build({ userId: 'member', config }, { prisma, crossProductPrisma: prisma,
          policy: { scope: 'all_active_memberships', serviceId: 'nessie', product: 'nessie' } });
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const shot = async name => {
          await page.evaluate(() => document.fonts.ready);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          assert.deepEqual(errors, []);
          await page.screenshot({ path: `${output}/${stage}/${width}-${name}.png`, fullPage: true });
        };
        await page.addInitScript(({ value, url }) => {
          window.__UOA_CLIENT_CONFIG__ = value; window.__UOA_CONFIG_URL__ = url;
        }, { value: config, url: configUrl });
        await page.route('**/auth/session-choices**', route => {
          assert.equal(new URL(route.request().url()).searchParams.get('config_url'), configUrl);
          return route.fulfill({ json: choices });
        });
        let selected;
        let release;
        const hold = new Promise(done => { release = done; });
        await page.route('**/auth/select-team**', async route => {
          assert.equal(new URL(route.request().url()).searchParams.get('config_url'), configUrl);
          selected = route.request().postDataJSON().teamId;
          if (stage === 'after') assert.ok(selected.startsWith('kilomayo-'));
          await hold;
          await route.fulfill({ json: { redirect_to: `${redirectUrl}?code=fixture&state=fixture` } });
        });
        await page.route(`${redirectUrl}**`, route => route.fulfill({ contentType: 'text/html', body:
          '<h1>Returned to Nessie</h1><p>Fixture OAuth callback. The separate Nessie tenant journey verifies the final channels page.</p>' }));
        const query = new URLSearchParams({ config_url: configUrl, redirect_url: redirectUrl,
          code_challenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', code_challenge_method: 'S256' });
        if (scenario === 'multiple') {
          await page.goto(`${origin}/auth?${query}`);
          await page.getByRole('link', { name: /Google/ }).waitFor();
          assert.equal(new URL(await page.getByRole('link', { name: /Google/ }).getAttribute('href'), origin)
            .searchParams.get('config_url'), configUrl);
          await shot('01-sign-in');
        }
        query.set('flow', 'team_chooser'); query.set('login_token', 'fixture-verified-login');
        const autoRequest = scenario === 'single' && stage === 'after'
          ? page.waitForRequest(request => request.url().includes('/auth/select-team')) : null;
        await page.goto(`${origin}/auth?${query}`);
        if (scenario === 'single' && stage === 'after') {
          await autoRequest;
          await shot('06-single-team-continuation');
          release(); await page.getByRole('heading', { name: 'Returned to Nessie' }).waitFor();
          assert.equal(selected, 'kilomayo-Research');
          await shot('07-return');
        } else {
          await page.getByRole('heading', { name: 'Choose a team' }).waitFor();
          if (scenario === 'multiple') {
            await page.getByText('Research', { exact: true }).waitFor();
            assert.equal(await page.getByText('Other Research', { exact: true }).count(), stage === 'before' ? 1 : 0);
            assert.equal(await page.getByText('Another organization Design', { exact: true }).count(), stage === 'before' ? 1 : 0);
            await shot('02-teams-and-invitations');
            await page.getByRole('button', { name: 'Create team', exact: true }).click();
            await page.getByRole('dialog').waitFor();
            await shot('03-create-team');
            await page.getByRole('button', { name: 'Cancel', exact: true }).click();
          } else if (scenario === 'empty') {
            if (stage === 'after') {
              await page.getByText('You don’t have access to any teams in this organization.').waitFor();
              await shot('04-no-access');
              await page.getByRole('button', { name: 'Back to sign in', exact: true }).click();
              await page.getByRole('link', { name: /Google/ }).waitFor();
              await shot('05-no-access-back');
            } else {
              await page.getByText('Other Research', { exact: true }).waitFor();
              await shot('04-no-access');
            }
          } else {
            await page.getByText('Research', { exact: true }).waitFor();
            await shot('06-single-team-continuation');
          }
        }
        release(); await page.close();
        console.log(stage, width, scenario, 'passed');
      }
    }
  }
} finally { await browser.close(); }
