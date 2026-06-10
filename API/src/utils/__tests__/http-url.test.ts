import { describe, expect, it } from 'vitest';

import { tryParseHttpUrl, tryParseRedirectUrl } from '../http-url.js';

describe('tryParseHttpUrl', () => {
  it('accepts http(s) URLs with a host', () => {
    expect(tryParseHttpUrl('https://app.example.com/cb')?.protocol).toBe('https:');
    expect(tryParseHttpUrl('http://evil.example/cb')?.protocol).toBe('http:');
  });

  it('rejects non-http(s) schemes and hostless URLs', () => {
    expect(tryParseHttpUrl('nessie://auth/callback')).toBeNull();
    expect(tryParseHttpUrl('not a url')).toBeNull();
  });
});

describe('tryParseRedirectUrl (RFC 8252 redirect policy)', () => {
  it('accepts https on any host', () => {
    expect(tryParseRedirectUrl('https://nessie.unlikeotherai.com/login')).not.toBeNull();
    expect(tryParseRedirectUrl('https://app.acme.com/callback')).not.toBeNull();
  });

  it('accepts http only on loopback', () => {
    expect(tryParseRedirectUrl('http://127.0.0.1:8888/callback')).not.toBeNull();
    expect(tryParseRedirectUrl('http://localhost:5173/cb')).not.toBeNull();
    expect(tryParseRedirectUrl('http://[::1]:7/cb')).not.toBeNull();
    expect(tryParseRedirectUrl('http://evil.example/cb')).toBeNull();
  });

  it('accepts native custom-scheme deep links', () => {
    expect(tryParseRedirectUrl('nessie://auth/callback')).not.toBeNull();
    expect(tryParseRedirectUrl('com.unlikeotherai.nessie.desktop://callback')).not.toBeNull();
    expect(tryParseRedirectUrl('cursor://anysphere.cursor-retrieval/oauth')).not.toBeNull();
  });

  it('round-trips a custom scheme so ?code= can be appended', () => {
    const url = tryParseRedirectUrl('nessie://auth/callback');
    url?.searchParams.set('code', 'ABC123');
    expect(url?.toString()).toBe('nessie://auth/callback?code=ABC123');
  });

  it('rejects dangerous and malformed schemes', () => {
    expect(tryParseRedirectUrl('javascript:alert(1)')).toBeNull();
    expect(tryParseRedirectUrl('javascript://%0aalert(1)')).toBeNull();
    expect(tryParseRedirectUrl('data://text/html,x')).toBeNull();
    expect(tryParseRedirectUrl('file:///etc/passwd')).toBeNull();
    expect(tryParseRedirectUrl('not a url')).toBeNull();
    expect(tryParseRedirectUrl('')).toBeNull();
  });
});
