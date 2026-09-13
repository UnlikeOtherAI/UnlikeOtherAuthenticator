import { describe, expect, it } from 'vitest';

import { resolveProductName, selectAllowedContinueUrl } from './continue-url.js';

const ALLOWED = 'https://app.nessie.works/login';
const CONFIG = {
  domain: 'api.nessie.works',
  redirect_urls: [ALLOWED, 'https://app.nessie.works/oauth/callback'],
  ui_theme: { logo: { url: '', alt: 'Nessie' } },
};

describe('selectAllowedContinueUrl', () => {
  it('accepts an exact entry of config.redirect_urls', () => {
    expect(selectAllowedContinueUrl(CONFIG, ALLOWED)).toBe(ALLOWED);
  });

  it('refuses anything the config does not list', () => {
    expect(selectAllowedContinueUrl(CONFIG, 'https://evil.example.com/phish')).toBeNull();
    expect(selectAllowedContinueUrl(CONFIG, `${ALLOWED}?next=/x`)).toBeNull();
  });

  it('refuses a non-http scheme even when the config lists it', () => {
    expect(
      selectAllowedContinueUrl({ ...CONFIG, redirect_urls: ['javascript:alert(1)'] }, 'javascript:alert(1)'),
    ).toBeNull();
  });

  it('refuses an empty request and a config without a usable allow-list', () => {
    expect(selectAllowedContinueUrl(CONFIG, null)).toBeNull();
    expect(selectAllowedContinueUrl(CONFIG, '  ')).toBeNull();
    expect(selectAllowedContinueUrl({ domain: 'x' }, ALLOWED)).toBeNull();
    expect(selectAllowedContinueUrl(null, ALLOWED)).toBeNull();
  });
});

describe('resolveProductName', () => {
  it('prefers the logo alt text', () => {
    expect(resolveProductName(CONFIG, 'the app')).toBe('Nessie');
  });

  it('falls back to the domain, then to the caller fallback', () => {
    const noAlt = { ...CONFIG, ui_theme: { logo: { url: '', alt: '  ' } } };
    expect(resolveProductName(noAlt, 'the app')).toBe('api.nessie.works');
    expect(resolveProductName({}, 'the app')).toBe('the app');
    expect(resolveProductName(undefined, 'the app')).toBe('the app');
  });
});
