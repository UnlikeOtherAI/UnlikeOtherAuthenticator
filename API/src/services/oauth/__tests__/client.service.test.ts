import { describe, expect, it } from 'vitest';

import { isAllowedRedirectUri } from '../client.service.js';

// Redirect-URI policy for public MCP clients (RFC 8252): https anywhere, http only
// for loopback, native custom schemes allowed, everything else rejected.
describe('isAllowedRedirectUri', () => {
  it('allows https', () => {
    expect(isAllowedRedirectUri('https://claude.ai/oauth/callback')).toBe(true);
  });

  it('allows http only on loopback', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:7777/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:5173/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://evil.example/cb')).toBe(false);
  });

  it('allows native custom schemes', () => {
    expect(isAllowedRedirectUri('cursor://anysphere.cursor-retrieval/oauth')).toBe(true);
    expect(isAllowedRedirectUri('com.example.app://callback')).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isAllowedRedirectUri('not a url')).toBe(false);
    expect(isAllowedRedirectUri('')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
  });
});
