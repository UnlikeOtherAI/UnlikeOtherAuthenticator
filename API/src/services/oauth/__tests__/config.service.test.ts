import { describe, expect, it } from 'vitest';

import { buildMcpClientConfig } from '../config.service.js';

// The synthesized first-party config must be valid (it goes through
// validateConfigFields) and carry the registered client's redirect URIs.
describe('buildMcpClientConfig', () => {
  it('produces a valid config from the client redirect URIs', () => {
    const config = buildMcpClientConfig(['https://claude.ai/cb', 'http://127.0.0.1:9/cb']);
    expect(config.redirect_urls).toEqual(['https://claude.ai/cb', 'http://127.0.0.1:9/cb']);
    expect(config.domain).toBeTruthy();
    expect(config.enabled_auth_methods).toContain('email_password');
    // 2FA honoured; org features off; sessions defaulted.
    expect(config['2fa_enabled']).toBe(true);
    expect(config.org_features?.enabled).toBe(false);
    expect(config.session?.remember_me_default).toBeDefined();
  });
});
