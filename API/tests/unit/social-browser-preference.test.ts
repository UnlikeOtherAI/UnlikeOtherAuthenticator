import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it } from 'vitest';
import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { consumeSocialPreference, preferredSocialRedirect, rememberCompletedSocialProvider,
  SOCIAL_PREFERENCE_COOKIE } from '../../src/services/social/social-browser-preference.service.js';

const configUrl = 'https://client.example.com/auth-config';
const config = validateConfigFields(baseClientConfigPayload({ enabled_auth_methods: ['google', 'apple'] }));
const start = `/auth?config_url=${encodeURIComponent(configUrl)}&team_hint=team-a`
  + `&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&state=opaque-state`;

async function fixture() {
  const app = Fastify();
  await app.register(cookie, { secret: 'unit-cookie-secret-with-enough-length' });
  app.get('/remember/:method', (request, reply) => {
    rememberCompletedSocialProvider(reply, (request.params as { method: string }).method);
    return { ok: true };
  });
  app.get('/auth', (request, reply) => {
    const redirect = preferredSocialRedirect({ config, configUrl, requestUrl: request.raw.url!, request });
    if (!redirect) return { choices: true };
    consumeSocialPreference(reply);
    return reply.redirect(redirect);
  });
  await app.ready();
  return app;
}

describe('browser provider preference', () => {
  it('remembers only a provider name in a signed host-only HTTPS cookie', async () => {
    const app = await fixture();
    try {
      const response = await app.inject({ url: '/remember/google' });
      const value = String(response.headers['set-cookie']);
      expect(value).toContain(`${SOCIAL_PREFERENCE_COOKIE}=`);
      expect(value).toContain('Path=/auth');
      expect(value).toContain('Secure');
      expect(value).toContain('HttpOnly');
      expect(value).toContain('SameSite=Lax');
      expect(value).not.toContain('Domain=');
      expect((await app.inject({ url: '/remember/email_password' })).headers['set-cookie']).toBeUndefined();
    } finally { await app.close(); }
  });

  it('selects an enabled remembered provider for one exact-team attempt and consumes the preference', async () => {
    const app = await fixture();
    try {
      const response = await app.inject({ url: start,
        cookies: { [SOCIAL_PREFERENCE_COOKIE]: app.signCookie('apple') } });
      expect(response.statusCode).toBe(302);
      const target = new URL(String(response.headers.location), 'https://auth.example.com');
      expect(target.pathname).toBe('/auth/social/apple');
      expect(target.searchParams.get('config_url')).toBe(configUrl);
      expect(target.searchParams.get('team_hint')).toBe('team-a');
      expect(target.searchParams.get('state')).toBe('opaque-state');
      expect(target.searchParams.get('code_challenge')).toBe('a'.repeat(43));
      expect(String(response.headers['set-cookie'])).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect((await app.inject({ url: start })).json()).toEqual({ choices: true });
    } finally { await app.close(); }
  });

  it.each([
    '', '&prompt=select_account', '&client_id=native', '&sso_intent=intent', '&management_org_id=org',
    '&enterprise_link_intent=link', '&invite_token=invite', '&flow=team_chooser', '&login_token=bridge',
    '&twofa_token=factor', '&twofa_setup_token=factor', '&signing_token=signature', '&error=access_denied',
    '&request_access=true', '&team_hint=second', '&code_challenge_method=S256',
  ])('keeps choices for excluded or ambiguous launches: %s', async extra => {
    const app = await fixture();
    try {
      const url = extra === '' ? start.replace('&team_hint=team-a', '') : start + extra;
      expect((await app.inject({ url, cookies: { [SOCIAL_PREFERENCE_COOKIE]: app.signCookie('google') } })).json())
        .toEqual({ choices: true });
    } finally { await app.close(); }
  });

  it.each(['github', 'email_password', 'google-forged'])('ignores absent, disabled or forged preferences: %s', async provider => {
    const app = await fixture();
    try {
      const value = provider === 'google-forged' ? 'google' : app.signCookie(provider);
      expect((await app.inject({ url: start, cookies: { [SOCIAL_PREFERENCE_COOKIE]: value } })).json())
        .toEqual({ choices: true });
      expect((await app.inject({ url: start.replace('team-a', '%3Cscript%3E'),
        cookies: { [SOCIAL_PREFERENCE_COOKIE]: app.signCookie('google') } })).json()).toEqual({ choices: true });
    } finally { await app.close(); }
  });

  it('does not consume a preference on HEAD or incomplete PKCE requests', async () => {
    const app = await fixture();
    try {
      const cookies = { [SOCIAL_PREFERENCE_COOKIE]: app.signCookie('google') };
      const head = await app.inject({ method: 'HEAD', url: start, cookies });
      expect(head.statusCode).toBe(200);
      expect(head.headers['set-cookie']).toBeUndefined();
      const invalid = await app.inject({ url: start.replace('a'.repeat(43), 'invalid'), cookies });
      expect(invalid.json()).toEqual({ choices: true });
      expect(invalid.headers['set-cookie']).toBeUndefined();
    } finally { await app.close(); }
  });
});
