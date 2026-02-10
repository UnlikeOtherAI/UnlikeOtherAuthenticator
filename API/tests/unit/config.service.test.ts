import { describe, expect, it } from 'vitest';
import type { JWTPayload } from 'jose';

import { validateConfigFields } from '../../src/services/config.service.js';

function basePayload(): JWTPayload {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: {},
    language_config: 'en',
  };
}

describe('validateConfigFields', () => {
  it('applies defaults for optional fields when missing', () => {
    const cfg = validateConfigFields(basePayload());

    expect(cfg.user_scope).toBe('global');
    expect(cfg['2fa_enabled']).toBe(false);
    expect(cfg.debug_enabled).toBe(false);
    expect(cfg.allowed_social_providers).toBeUndefined();
  });

  it('parses optional fields when provided', () => {
    const cfg = validateConfigFields({
      ...basePayload(),
      user_scope: 'per_domain',
      '2fa_enabled': true,
      debug_enabled: true,
      allowed_social_providers: ['google', 'github'],
    });

    expect(cfg.user_scope).toBe('per_domain');
    expect(cfg['2fa_enabled']).toBe(true);
    expect(cfg.debug_enabled).toBe(true);
    expect(cfg.allowed_social_providers).toEqual(['google', 'github']);
  });

  it('rejects invalid user_scope values', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        user_scope: 'nope',
      } as unknown as JWTPayload),
    ).toThrow();
  });

  it('rejects invalid allowed_social_providers shapes', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        allowed_social_providers: 'google',
      } as unknown as JWTPayload),
    ).toThrow();

    expect(() =>
      validateConfigFields({
        ...basePayload(),
        allowed_social_providers: [''],
      }),
    ).toThrow();
  });

  it('rejects invalid redirect_urls entries', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        redirect_urls: ['javascript:alert(1)'],
      }),
    ).toThrow();

    expect(() =>
      validateConfigFields({
        ...basePayload(),
        redirect_urls: ['/relative/path'],
      }),
    ).toThrow();
  });

  it('trims redirect_urls entries', () => {
    const cfg = validateConfigFields({
      ...basePayload(),
      redirect_urls: ['  https://client.example.com/oauth/callback  '],
    });

    expect(cfg.redirect_urls).toEqual(['https://client.example.com/oauth/callback']);
  });
});
