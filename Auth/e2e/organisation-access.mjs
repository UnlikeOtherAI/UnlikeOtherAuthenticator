// Local, headless browser evaluation. Not invoked by CI or the ordinary test command.
// Start Auth's Vite server, set UOA_AUTH_PREVIEW and optionally PLAYWRIGHT_MODULE.
/* global window, document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.UOA_AUTH_PREVIEW ?? 'http://127.0.0.1:5187';
const output = process.env.UOA_SCREENSHOTS ?? 'Auth/e2e/artifacts/organisation-access';
await mkdir(output, { recursive: true });
const config = {
  language_config: ['en', 'cs', 'es'], language: 'en',
  ui_theme: {
    colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb',
      primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
    radii: { card: '16px', button: '8px', input: '8px' }, density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' }, button: { style: 'solid' },
    card: { style: 'bordered' }, logo: { text: 'UnlikeOtherAI', alt: 'UnlikeOtherAI' },
  },
};
const base = {
  ok: true, org: { id: 'org-acme', name: 'Acme Research' }, client_domain: 'api.nessie.works', csrf_token: 'fixture-csrf',
  connections: [], domains: [], teams: [{id:'team-one',name:'Research'}], policy: { enforcement: 'off', revision: 1, session_max_age_seconds: 28800, reauth_mode: 'detect_only', jit_enabled:false, default_team_id:null, allow_unverified_contractors:false, group_mappings:[] },
  readiness: { activation_allowed: false, enforcement_allowed: false, blockers: ['RECOVERY_SETUP_REQUIRED', 'REVOCATION_CONSUMERS_REQUIRED'] },
  presets: ['entra', 'okta', 'google_workspace', 'keycloak', 'adfs', 'other_oidc', 'other_saml'].map((id) => ({ id, protocols: ['adfs', 'other_saml'].includes(id) ? ['saml'] : ['oidc'] })),
  scim: { enabled: false },
};
const saved = {
  id: 'connection-one', preset: 'entra', protocol: 'oidc', display_name: 'Acme Microsoft', status: 'draft',
  revision: 1, configuration: {}, secret_configured: true, tested_revision: null,
  callback_url: `${origin}/sso/connection-one/callback`,
  acs_url: `${origin}/sso/connection-one/acs`, sp_entity_id: `${origin}/sso/connection-one/metadata`,metadata_url:`${origin}/sso/connection-one/metadata`,sp_key_state:'current',
};
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => console.error(error.message));
    await page.addInitScript((value) => { window.__UOA_CLIENT_CONFIG__ = value; }, config);
    let data = structuredClone(base);
    let mode = 'normal'; let reconciled=false; const mutations = [];
    await page.route('**/sso/connection-one/start', async (route) => {
      data.connections[0].tested_revision = data.connections[0].revision;
      data.connections[0].last_test = { status: 'passed', code: 'OK', at: new Date().toISOString() };
      await route.fulfill({ status: 302, headers: { location: `${origin}/auth/organisation-access?test=connection-one` } });
    });
    await page.route('**/auth/organisation-access/**', async (route) => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (path.endsWith('/exchange')) return route.fulfill({ json: data });
      if (request.method() === 'GET' && path.endsWith('/sso')) {
        if (mode === 'outage') return route.fulfill({ status: 503, json: { error: 'Request failed' } });
        if (mode === 'expired') return route.fulfill({ status: 401, json: { error: 'Request failed' } });
        return route.fulfill({ json: { ...data, domains: data.domains.map((domain) => ({ ...domain, challenge: undefined })) } });
      }
      if(request.method()==='GET'&&path.endsWith('/sso/recovery')&&mode==='recovery-unavailable')return route.fulfill({json:{revision:2,
        setup_complete:false,drill_complete:false,next_cursor:null,contacts:[
          {user_id:'owner',status:'confirmed',confirmed_at:new Date().toISOString(),last_drill_at:new Date().toISOString()},
          {user_id:'ineligible',status:'unavailable',confirmed_at:null,last_drill_at:null}],candidates:[
          {user_id:'owner',display_name:'Alex Owner',email:'alex@acme.example',eligible:true},
          {user_id:'custodian',display_name:'Sam Research',email:'sam@acme.example',eligible:true},
          {user_id:'ineligible',display_name:'Taylor Research',email:'taylor@acme.example',eligible:false}]}});
      if (request.method()==='GET' && path.endsWith('/sso/recovery')) return route.fulfill({json:{revision:1,
        setup_complete:false,drill_complete:false,contacts:[],next_cursor:null,candidates:[
          {user_id:'owner',display_name:'Alex Owner',email:'alex@acme.example',eligible:true},
          {user_id:'custodian',display_name:'Sam Research',email:'sam@acme.example',eligible:true},
          {user_id:'ineligible',display_name:'Taylor Research',email:'taylor@acme.example',eligible:false}]}});
      if (request.method()==='GET' && path.endsWith('/scim')) return route.fulfill({json:{ok:true,enabled:true,revision:1,
        base_url:origin+'/scim/v2/c/connection-one',tokens:[],pending_resources:reconciled?[]:[{id:'resource-one',resource_type:'Users',external_id:'provisioner-one',user_name:'alex@acme.example',display_name:'Alex Research',version:1}],linked_identities:[{id:'identity-one',subject:'stable-provider-person-123',user_id:'canonical-one'}],
        next_resource_cursor:null,next_identity_cursor:null,groups:[]}});
      assert.equal(request.headers()['x-uoa-csrf'], 'fixture-csrf');
      mutations.push({ path, body: request.postDataJSON() });
      if(path.includes('/sp-key/')) {
        const c=data.connections[0];assert.equal(request.postDataJSON().revision,c.revision);
        if(!path.endsWith('/prepare'))assert.equal(c.tested_revision,c.revision);
        c.sp_key_state=path.endsWith('/prepare')?'prepared':path.endsWith('/activate')?'overlap':'current';
        c.key_overlap_expires_at=c.sp_key_state==='overlap'?'2026-11-01T12:00:00Z':null;
        c.revision++;c.tested_revision=null;
        return route.fulfill({json:{ok:true,connection:c}});
      }
      if (path.endsWith('/policy') && request.method()==='PATCH') {
        const body=request.postDataJSON();assert.equal(body.revision,data.policy.revision);
        assert.equal(Object.hasOwn(body,'discovery_enabled'),false);
        data.policy={...data.policy,...body,revision:data.policy.revision+1};
        return route.fulfill({json:{ok:true,revision:data.policy.revision}});
      }
      if(path.endsWith('/scim/reconcile')) {
        assert.deepEqual(request.postDataJSON(),{resource_id:'resource-one',external_identity_id:'identity-one',version:1});
        reconciled=true;return route.fulfill({json:{ok:true}});
      }
      if(path.endsWith('/credentials/rotate')) {
        const body=request.postDataJSON();
        if(body.secret==='fixture-rejected-secret')return route.fulfill({status:503,json:{error:'Request failed'}});
        assert.equal(body.revision,data.connections[0].revision);
        data.connections[0]={...data.connections[0],revision:data.connections[0].revision+1,tested_revision:null};
        return route.fulfill({json:{ok:true,connection:data.connections[0]}});
      }
      if (path.endsWith('/connections')) {
        const body = request.postDataJSON();
        data.connections = [{ ...saved, ...body, secret: undefined }];
        return route.fulfill({ json: { ok: true, connection: data.connections[0] } });
      }
      if (request.method() === 'PATCH' && path.endsWith('/connections/connection-one')) {
        data.connections[0] = { ...data.connections[0], ...request.postDataJSON(), secret: undefined, revision: 2 };
        return route.fulfill({ json: { ok: true, connection: data.connections[0] } });
      }
      if (path.endsWith('/connections/connection-one/test')) {
        assert.equal(request.postDataJSON().revision,data.connections[0].revision);
        return route.fulfill({ json: { ok: true, test_url: `${origin}/sso/connection-one/start`, expires_at: '2026-10-18T12:00:00Z' } });
      }
      if (path.endsWith('/connections/connection-one/scim/tokens')) {
        return route.fulfill({ json: { ok: true, token: 'fixture-one-time-provisioning-token', base_url: `${origin}/scim/v2/c/connection-one` } });
      }
      if (path.endsWith('/metadata/parse')) return route.fulfill({json:{ok:true,configuration:{entity_id:'https://provider.example/saml',sso_url:'https://provider.example/sign-in',certificates:['-----BEGIN CERTIFICATE-----\nTEST-FIXTURE\n-----END CERTIFICATE-----']}}});
      if (path.endsWith('/domains')) {
        data.domains.push({ id: 'domain-one', email_domain: 'acme.example', status: 'PENDING',
          challenge: { name: '_uoa-verify.acme.example', value: 'public-dns-proof', expires_at: '2026-10-18T12:00:00Z' } });
        return route.fulfill({ json: { ok: true, domain: data.domains.at(-1) } });
      }
      if(request.method()==='DELETE'&&path.endsWith('/domains/domain-one')){data.domains[0].status='REVOKED';return route.fulfill({json:{ok:true}});}
      if (path.endsWith('/domains/domain-one/reissue')) {
        const domain = data.domains[0];domain.status='PENDING';
        domain.challenge.value = 'replacement-public-dns-proof';
        return route.fulfill({ json: { ok: true, domain } });
      }
      return route.fulfill({ status: 400, json: { error: 'Request failed' } });
    });
    const shot = async (name) => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.screenshot({ path: `${output}/${width}-${name}.png`, fullPage: true });
      console.log(`${width}: ${name}`);
    };
    await page.goto(`${origin}/auth/organisation-access#continuation=one-use-fixture`);
    await page.getByRole('button', { name: 'Choose provider', exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, ''); await shot('first-time');
    await page.getByRole('button',{name:'Who can sign in',exact:true}).click();
    assert.equal(await page.getByRole('checkbox').count(),2);
    assert.equal(await page.getByRole('checkbox',{name:'Allow existing members outside verified email domains'}).isChecked(),false);
    await page.getByRole('checkbox',{name:'Let people from verified email domains join on their first provider sign-in'}).check();
    await page.getByLabel('Team for new people',{exact:true}).selectOption('team-one');
    await shot('access-policy');
    await page.getByRole('button',{name:'Save sign-in policy',exact:true}).click();
    await page.getByText('Sign-in policy saved.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await page.getByRole('button', { name: 'Choose provider', exact: true }).click(); await shot('choose');
    await page.getByRole('button', { name: 'Microsoft Entra ID', exact: true }).click(); await shot('connect');
    await page.getByLabel('Directory (tenant) ID').fill('11111111-1111-1111-1111-111111111111');
    await page.getByLabel('Application (client) ID').fill('application-id');
    await page.getByLabel('Client secret', { exact: true }).fill('fixture-write-only-secret');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await page.getByRole('heading', { name: 'Microsoft Entra ID', exact: true }).waitFor();
    await shot('saved-untested');
    const reply = page.locator('code').first();
    assert.ok((await reply.boundingBox()).width > 150, 'Reply URL must remain readable beside its copy action');
    assert.equal(await page.getByRole('button', { name: 'Turn on', exact: true }).count(), 0);
    assert.equal(await page.getByText('fixture-write-only-secret').count(), 0);
    const connectionMutations=mutations.filter(mutation=>mutation.path.includes('/connections'));
    assert.deepEqual(connectionMutations[0].body.configuration, {});
    assert.equal(connectionMutations[1].body.configuration.tenant.claim, 'tid');
    await page.getByRole('button', { name: 'Test sign-in', exact: true }).click();
    await page.getByText('Sign-in worked for this saved configuration.', { exact: false }).waitFor(); await shot('test-passed-blocked');
    data.connections[0].tested_revision = null; data.connections[0].last_test.status = 'failed';
    await page.reload(); await page.getByRole('button', { name: /Microsoft Entra ID/ }).click(); await shot('test-failed');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Email domains', exact: true }).click();
    await page.getByLabel('Email domain', { exact: true }).fill('acme.example');
    await page.getByRole('button', { name: 'Add domain', exact: true }).click();
    await page.getByText('public-dns-proof', { exact: true }).waitFor(); await shot('domain-pending');
    await page.reload(); await page.getByRole('button', { name: 'Email domains', exact: true }).click();
    await page.getByRole('button', { name: 'Get a new DNS record', exact: true }).click();
    await page.getByText('replacement-public-dns-proof', { exact: true }).waitFor(); await shot('domain-reissued');
    data.domains[0].status='LAPSED';await page.reload();
    await page.getByRole('button',{name:'Email domains',exact:true}).click();
    await page.getByText('Verification lapsed',{exact:true}).waitFor();await shot('domain-lapsed');
    await page.locator('summary').filter({hasText:'Stop using this domain'}).click();
    await page.getByRole('button',{name:'Stop using this domain',exact:true}).click();
    await page.getByText('Domain no longer in use',{exact:true}).waitFor();await shot('domain-revoked');

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Recovery and required sign-in', exact: true }).click(); await page.getByText('Alex Owner',{exact:true}).waitFor(); await shot('recovery');
    await page.getByTestId('language-selector').selectOption('cs'); await shot('recovery-cs');
    await page.getByTestId('language-selector').selectOption('es'); await shot('recovery-es');
    await page.getByTestId('language-selector').selectOption('en');
    mode='recovery-unavailable';await page.reload();
    await page.getByRole('button',{name:'Recovery and required sign-in',exact:true}).click();
    await page.getByText('Recovery practice complete',{exact:true}).waitFor();
    const replace=page.getByRole('button',{name:'Replace recovery contacts and links',exact:true});
    assert.equal(await replace.isDisabled(),true);
    await shot('recovery-unavailable');
    await page.getByRole('checkbox',{name:/Taylor Research/}).uncheck();
    await page.getByRole('checkbox',{name:/Sam Research/}).check();
    assert.equal(await replace.isDisabled(),false);
    mode = 'outage'; await page.reload(); await page.getByRole('alert').waitFor(); await shot('outage');
    mode = 'expired'; await page.reload(); await page.getByRole('alert').waitFor(); await shot('expired');
    mode = 'normal'; data.scim.enabled = true;
    await page.reload(); await page.getByRole('button', { name: /Microsoft Entra ID/ }).click();
    await page.getByText('Automatic access management', { exact: true }).click();
    await page.getByRole('button', { name: 'Create provisioning token', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create provisioning token', exact: true }).click();
    await page.getByText('fixture-one-time-provisioning-token', { exact: true }).waitFor(); await shot('provisioning-token-once');
    await page.getByRole('button', { name: 'I have saved the token', exact: true }).click();
    assert.equal(await page.getByText('fixture-one-time-provisioning-token', { exact: true }).count(), 0);
    await page.getByLabel('Connected provider user ID',{exact:true}).selectOption('identity-one');
    await shot('provisioning-reconcile');
    await page.getByRole('button',{name:'Connect selected identity',exact:true}).click();
    await page.getByText('No people are waiting to be connected.',{exact:true}).waitFor();
    await page.getByText('Credentials and certificates',{exact:true}).click();
    await page.getByLabel('Client secret',{exact:true}).fill('fixture-rejected-secret');
    await page.getByRole('button',{name:'Save replacement credential',exact:true}).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('Client secret',{exact:true}).inputValue(),'fixture-rejected-secret');
    await shot('credential-replacement-failed');
    await page.getByLabel('Client secret',{exact:true}).fill('fixture-replacement-secret');
    await page.getByRole('button',{name:'Save replacement credential',exact:true}).click();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('input[type=password]')).every(input=>input.value===''));
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button',{name:'Who can sign in',exact:true}).click();
    await page.getByText('Provider group access',{exact:true}).click();
    await page.getByRole('button',{name:'Add group',exact:true}).click();
    await page.getByLabel('Identity provider',{exact:true}).selectOption('connection-one');
    await page.getByLabel('Provider group ID',{exact:true}).fill('provider-group-123');
    await page.getByLabel('UOA team',{exact:true}).selectOption('team-one');
    await shot('provider-group-access');
    await page.getByRole('button',{name:'Save sign-in policy',exact:true}).click();
    await page.getByText('Sign-in policy saved.',{exact:true}).waitFor();
    assert.equal(data.policy.group_mappings[0].connection_id,'connection-one');
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    await page.getByRole('button', { name: 'Other SAML', exact: true }).click();
    await page.getByLabel('Identity provider identifier', { exact: true }).waitFor(); await shot('saml-connect');
    assert.ok((await page.locator('code').first().boundingBox()).width > 150);
    await page.getByRole('textbox',{name:'Import provider metadata',exact:true}).fill('<EntityDescriptor/>');
    await page.getByRole('button',{name:'Fill from metadata',exact:true}).click();
    await page.getByLabel('Identity provider identifier',{exact:true}).waitFor();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('input')).some(input=>input.value==='https://provider.example/saml'));
    assert.equal(await page.getByLabel('Identity provider identifier',{exact:true}).inputValue(),'https://provider.example/saml');
    await shot('saml-metadata-filled');
    await page.getByLabel('Stable user ID attribute',{exact:true}).fill('permanent_id');
    await page.getByLabel('Tenant attribute',{exact:true}).fill('organisation_id');
    await page.getByLabel('Tenant value',{exact:true}).fill('acme');
    await page.getByRole('button',{name:'Save connection',exact:true}).click();
    await page.getByText('Credentials and certificates',{exact:true}).click();
    await page.getByRole('button',{name:'Prepare new UOA certificate',exact:true}).click();
    await page.getByRole('button',{name:'Activate tested certificate',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Activate tested certificate',exact:true}).isDisabled(),true);
    await shot('saml-key-prepared');
    await page.getByRole('button',{name:'Test sign-in',exact:true}).click();
    await page.getByText('Sign-in worked for this saved configuration.',{exact:false}).waitFor();
    await page.getByText('Credentials and certificates',{exact:true}).click();
    await page.getByRole('button',{name:'Activate tested certificate',exact:true}).click();
    await page.getByRole('button',{name:'Retire previous certificate',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Retire previous certificate',exact:true}).isDisabled(),true);
    await shot('saml-key-overlap');
    await page.getByRole('button',{name:'Test sign-in',exact:true}).click();
    await page.getByText('Sign-in worked for this saved configuration.',{exact:false}).waitFor();
    await page.getByText('Credentials and certificates',{exact:true}).click();
    await page.getByRole('button',{name:'Retire previous certificate',exact:true}).click();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Prepare new UOA certificate'&&!button.disabled));

    await page.close();
  }
  console.log('Organisation access headless journeys passed at 390px and 1280px.');
} finally { await browser.close(); }
