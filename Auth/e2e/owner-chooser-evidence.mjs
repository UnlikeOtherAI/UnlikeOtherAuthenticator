// Local headless comparison; never invoked by ordinary tests or CI.
/* global window, document, innerWidth */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
 ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = process.env.UOA_SCREENSHOTS ?? 'Docs/evidence/pr-117-ui';
const config = { domain: 'api.nessie.works', enabled_auth_methods: ['google'], allow_registration: false,
 language_config: ['en'], language: 'en', login_flow: { team_selection: 'auto' },
 ui_theme: { colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb',
 primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
 radii: { card: '16px', button: '8px', input: '8px' }, density: 'comfortable',
 typography: { font_family: 'sans', base_text_size: 'md' }, button: { style: 'solid' }, card: { style: 'bordered' },
 logo: { text: 'UnlikeOtherAI', alt: 'UnlikeOtherAI' } } };
const choices = { teams: ['Research', 'Operations'].map((name,index)=>({teamId: `team-${index}`, orgId: 'org-acme',
 name, role: 'owner', orgName: 'Acme Research', can_manage_sso: true, slug: name.toLowerCase(), iconUrl: null})),
 pending_invites: [], can_create_org: false, creatable_orgs: [], manageable_orgs: [{orgId:'org-acme',orgName:'Acme Research'}] };
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
try {
 for (const [stage,origin] of [['before',process.env.UOA_AUTH_PREVIEW_BEFORE ?? 'http://127.0.0.1:5197'],
  ['after',process.env.UOA_AUTH_PREVIEW_AFTER ?? 'http://127.0.0.1:5196']]) {
  await mkdir(`${output}/${stage}`, {recursive:true});
  for (const width of [390,1280]) {
   const page = await browser.newPage({viewport:{width,height:900}});
   const errors=[]; page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(value=>{window.__UOA_CLIENT_CONFIG__=value;window.__UOA_CONFIG_URL__='https://api.nessie.works/auth/config';},config);
   await page.route('**/auth/session-choices**',route=>route.fulfill({json:choices}));
   const query=new URLSearchParams({config_url:'https://api.nessie.works/auth/config',redirect_url:'https://app.nessie.works/auth/callback',
    flow:'team_chooser',login_token:'fixture-verified-owner-continuation'});
   await page.goto(`${origin}/auth?${query}`);
   await page.getByText('Research',{exact:true}).waitFor();
   await page.evaluate(()=>document.fonts.ready);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.deepEqual(errors,[]);
   await page.screenshot({path:`${output}/${stage}/${width}-owner-chooser.png`,fullPage:true});
   console.log(stage,width,await page.locator('h1').allTextContents());
   await page.close();
  }
 }
} finally {await browser.close();}
