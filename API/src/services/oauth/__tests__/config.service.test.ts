import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMcpClientConfig } from '../config.service.js';

// The synthesized first-party config must be valid (it goes through
// validateConfigFields) and carry the registered client's redirect URIs.
describe('buildMcpClientConfig', () => {
  const originalDomain = process.env.MCP_OAUTH_DOMAIN;
  const originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;
  const originalIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeEach(() => {
    // The MCP profile must run on its own dedicated first-party domain, never the
    // admin domain. Set a distinct domain for the happy-path cases.
    process.env.MCP_OAUTH_DOMAIN = 'mcp.example.com';
    process.env.ADMIN_AUTH_DOMAIN = 'admin.example.com';
    process.env.AUTH_SERVICE_IDENTIFIER = 'admin.example.com';
  });

  afterEach(() => {
    process.env.MCP_OAUTH_DOMAIN = originalDomain;
    process.env.ADMIN_AUTH_DOMAIN = originalAdminDomain;
    process.env.AUTH_SERVICE_IDENTIFIER = originalIdentifier;
  });

  it('produces a valid config from the client redirect URIs', () => {
    const config = buildMcpClientConfig(['https://claude.ai/cb', 'http://127.0.0.1:9/cb']);
    expect(config.redirect_urls).toEqual(['https://claude.ai/cb', 'http://127.0.0.1:9/cb']);
    expect(config.domain).toBe('mcp.example.com');
    expect(config.enabled_auth_methods).toContain('email_password');
    // 2FA honoured; org features off; sessions defaulted.
    expect(config['2fa_enabled']).toBe(true);
    expect(config.org_features?.enabled).toBe(false);
    expect(config.session?.remember_me_default).toBeDefined();
  });

  it('throws when MCP_OAUTH_DOMAIN is unset (fail closed, never falls back to admin)', () => {
    delete process.env.MCP_OAUTH_DOMAIN;
    // Guard against an empty-string leftover too: both unset and "" must fail closed.
    expect(process.env.MCP_OAUTH_DOMAIN).toBeUndefined();
    expect(() => buildMcpClientConfig(['https://claude.ai/cb'])).toThrowError(
      'MCP_OAUTH_DOMAIN_REQUIRED',
    );
  });

  it('throws when MCP_OAUTH_DOMAIN equals the admin domain', () => {
    process.env.MCP_OAUTH_DOMAIN = 'admin.example.com';
    expect(() => buildMcpClientConfig(['https://claude.ai/cb'])).toThrowError(
      'MCP_OAUTH_DOMAIN_FORBIDDEN_ADMIN',
    );
  });
});
