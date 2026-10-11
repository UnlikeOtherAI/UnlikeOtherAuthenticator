import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../../config/env.js';
import { assertKelpieScopeClient, kelpieConnectResource } from '../kelpie-connect-policy.js';

const previous = process.env.KELPIE_CONNECT_RESOURCE;
afterEach(() => {
  if (previous === undefined) delete process.env.KELPIE_CONNECT_RESOURCE;
  else process.env.KELPIE_CONNECT_RESOURCE = previous;
});

describe('Kelpie connection policy', () => {
  it('requires exact registered Kelpie app for the dedicated scope; unrelated grants stay unchanged', () => {
    expect(() => assertKelpieScopeClient(['kelpie.connect'], 'com.unlikeotherai.kelpie')).not.toThrow();
    expect(() => assertKelpieScopeClient(['profile'], 'com.example.browser')).not.toThrow();
    for (const value of [undefined, 'com.example.browser', 'com.unlikeotherai.kelpie.extra']) {
      expect(() => assertKelpieScopeClient(['kelpie.connect'], value)).toThrow();
    }
  });
  it('fails closed without a gateway and keeps the resource exact', () => {
    delete process.env.KELPIE_CONNECT_RESOURCE;
    expect(() => kelpieConnectResource()).toThrow();
    process.env.KELPIE_CONNECT_RESOURCE = 'https://api.nessie.works/api/kelpie/connect';
    expect(kelpieConnectResource()).toBe(process.env.KELPIE_CONNECT_RESOURCE);
  });
  it('rejects insecure, credentialed and query-bearing gateway configurations', () => {
    const base = { SHARED_SECRET: 'test-shared-secret-with-enough-length' };
    for (const resource of ['http://api.nessie.works/api/kelpie/connect',
      'https://user:password@api.nessie.works/api/kelpie/connect',
      'https://api.nessie.works/api/kelpie/connect?token=secret',
      'https://api.nessie.works/api/kelpie/connect#fragment',
      'https://api.nessie.works/other', 'https://api.nessie.works/api/kelpie/connect/']) {
      expect(() => parseEnv({ ...base, KELPIE_CONNECT_RESOURCE: resource })).toThrow();
    }
    expect(parseEnv({ ...base, KELPIE_CONNECT_RESOURCE: 'https://api.nessie.works/api/kelpie/connect' })
      .KELPIE_CONNECT_RESOURCE).toBe('https://api.nessie.works/api/kelpie/connect');
  });
});
