import { describe, expect, it } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { extractEmailTheme } from '../../src/services/email-theme.service.js';
import { testUiTheme } from '../helpers/test-config.js';

function configWithTheme(uiTheme: Record<string, unknown>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: uiTheme,
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'password_required',
    '2fa_enabled': false,
    debug_enabled: false,
  } as unknown as ClientConfig;
}

describe('extractEmailTheme', () => {
  it('keeps email-safe font and logo theme values', () => {
    const uiTheme = testUiTheme();
    uiTheme.typography = {
      font_family: 'sans',
      base_text_size: 'md',
      font_import_url: 'https://fonts.googleapis.com/css2?family=Inter',
    };
    uiTheme.logo = {
      url: '',
      alt: 'Logo',
      text: 'Client',
      font_size: '28px',
      color: '#123456',
      font_weight: '700',
      style: {
        fontFamily: '"Inter", Arial',
      },
    };

    expect(extractEmailTheme(configWithTheme(uiTheme))).toMatchObject({
      logoFontSize: '28px',
      logoFontWeight: '700',
      logoFontFamily: '"Inter", Arial',
      logoColor: '#123456',
      fontImportUrl: 'https://fonts.googleapis.com/css2?family=Inter',
    });
  });

  it('drops unsafe font imports and logo CSS values', () => {
    const uiTheme = testUiTheme();
    uiTheme.typography = {
      font_family: 'sans',
      base_text_size: 'md',
      font_import_url: 'https://evil.example.com/font.css',
    };
    uiTheme.logo = {
      url: '',
      alt: 'Logo',
      text: 'Client',
      font_size: 'calc(100% + 1px)',
      color: 'rgb(1, 2, 3)',
      font_weight: '700;display:none',
      style: {
        fontFamily: 'Arial; background:url(https://evil.example.com/x)',
      },
    };

    const theme = extractEmailTheme(configWithTheme(uiTheme));

    expect(theme.fontImportUrl).toBeUndefined();
    expect(theme.logoFontFamily).toBeUndefined();
    expect(theme.logoColor).toBeUndefined();
    expect(theme.logoFontSize).toBeUndefined();
    expect(theme.logoFontWeight).toBeUndefined();
  });
});
