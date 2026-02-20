import { describe, expect, it, vi } from 'vitest';
import type { JWTPayload } from 'jose';

import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

function basePayload(): JWTPayload {
  return baseClientConfigPayload();
}

describe('validateConfigFields', () => {
  it('applies defaults for optional fields when missing', () => {
    const cfg = validateConfigFields(basePayload());

    expect(cfg.user_scope).toBe('global');
    expect(cfg['2fa_enabled']).toBe(false);
    expect(cfg.debug_enabled).toBe(false);
    expect(cfg.allow_registration).toBe(true);
    expect(cfg.registration_mode).toBe('password_required');
    expect(cfg.allowed_registration_domains).toBeUndefined();
    expect(cfg.registration_domain_mapping).toBeUndefined();
    expect(cfg.allowed_social_providers).toBeUndefined();
  });

  it('parses optional fields when provided', () => {
    const cfg = validateConfigFields({
      ...basePayload(),
      user_scope: 'per_domain',
      '2fa_enabled': true,
      debug_enabled: true,
      allow_registration: false,
      registration_mode: 'password_required',
      allowed_registration_domains: ['  EXAMPLE.COM ', 'subsidiary.co.uk'],
      registration_domain_mapping: [
        {
          email_domain: '  EXAMPLE.COM  ',
          org_id: ' org-1 ',
          team_id: ' team-1 ',
        },
      ],
      allowed_social_providers: ['google', 'github'],
      language: '  es  ',
    });

    expect(cfg.user_scope).toBe('per_domain');
    expect(cfg['2fa_enabled']).toBe(true);
    expect(cfg.debug_enabled).toBe(true);
    expect(cfg.allow_registration).toBe(false);
    expect(cfg.registration_mode).toBe('password_required');
    expect(cfg.allowed_registration_domains).toEqual(['example.com', 'subsidiary.co.uk']);
    expect(cfg.registration_domain_mapping).toEqual([
      {
        email_domain: 'example.com',
        org_id: 'org-1',
        team_id: 'team-1',
      },
    ]);
    expect(cfg.allowed_social_providers).toEqual(['google', 'github']);
    expect(cfg.language).toBe('es');
  });

  it('rejects passwordless mode when registration is disabled', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        allow_registration: false,
        registration_mode: 'passwordless',
      }),
    ).toThrow();
  });

  it('rejects empty allowed_registration_domains arrays', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        allowed_registration_domains: [],
      }),
    ).toThrow();
  });

  it('rejects duplicate allowed_registration_domains values', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        allowed_registration_domains: ['example.com', 'example.com'],
      }),
    ).toThrow();
  });

  it('rejects duplicate registration_domain_mapping email domains', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        registration_domain_mapping: [
          { email_domain: 'example.com', org_id: 'org-1' },
          { email_domain: 'EXAMPLE.COM', org_id: 'org-2' },
        ],
      }),
    ).toThrow();
  });

  it('warns when registration_domain_mapping contains domains outside allowed_registration_domains', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = validateConfigFields({
      ...basePayload(),
      allowed_registration_domains: ['company.com'],
      registration_domain_mapping: [
        { email_domain: 'company.com', org_id: 'org-1' },
        { email_domain: 'gmail.com', org_id: 'org-2' },
      ],
    });

    expect(cfg.registration_domain_mapping).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toBe('[config]');

    warnSpy.mockRestore();
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
