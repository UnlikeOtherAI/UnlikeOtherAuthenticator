import { describe, expect, it } from 'vitest';
import { nativeRedirectMatches, validNativeRedirect, NativeAppIdentifier } from '../native-app-policy.js';
describe('native app policy', () => {
  it('requires a reverse-domain identifier and rejects URL-shaped values', () => {
    expect(NativeAppIdentifier.safeParse('com.unlikeotherai.kelpie').success).toBe(true);
    for (const value of ['kelpie', 'https://kelpie.app', 'com.Example.app', '../com.app']) expect(NativeAppIdentifier.safeParse(value).success).toBe(false);
  });
  it('allows exact custom links and only numeric loopback port changes', () => {
    expect(nativeRedirectMatches('http://127.0.0.1/oauth/callback', 'http://127.0.0.1:43210/oauth/callback')).toBe(true);
    expect(nativeRedirectMatches('com.example.app://oauth/callback', 'com.example.app://oauth/callback')).toBe(true);
    for (const value of ['http://127.0.0.1/other', 'http://localhost/oauth/callback', 'http://127.0.0.2/oauth/callback', 'http://127.0.0.1/oauth/callback?q=1'])
      expect(nativeRedirectMatches('http://127.0.0.1/oauth/callback', value)).toBe(false);
    for (const value of ['https://name:secret@example.com/callback', 'com.example.app://oauth/callback#fragment', 'javascript://alert(1)', 'http://remote.example/callback']) expect(validNativeRedirect(value)).toBe(false);
  });
});
