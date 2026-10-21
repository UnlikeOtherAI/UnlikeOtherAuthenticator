import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealEnterpriseSecret, openEnterpriseSecret } from '../../src/services/enterprise-secret.service.js';
import { createEnterpriseSpKey } from '../../src/services/org-sso-sp-key.service.js';
import { X509Certificate } from 'node:crypto';

describe('enterprise envelope custody', () => {
  const priorProvider = process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER;
  const priorRing = process.env.ENTERPRISE_SSO_KEYRING;
  const keyA = randomBytes(32).toString('base64');
  const keyB = randomBytes(32).toString('base64');
  beforeEach(() => {
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'a', keys: { a: keyA } });
  });
  afterEach(() => {
    if (priorProvider === undefined) delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER;
    else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = priorProvider;
    if (priorRing === undefined) delete process.env.ENTERPRISE_SSO_KEYRING;
    else process.env.ENTERPRISE_SSO_KEYRING = priorRing;
  });
  it('uses different wrapped data keys and nonces for identical plaintext', async () => {
    const first = await sealEnterpriseSecret('test-upstream-secret', 'connection:a');
    const second = await sealEnterpriseSecret('test-upstream-secret', 'connection:a');
    expect(first).not.toContain('test-upstream-secret'); expect(first).not.toEqual(second);
    expect(JSON.parse(first).version).toBe(2); expect(JSON.parse(first).wrapped_key).not.toEqual(JSON.parse(second).wrapped_key);
    expect(await openEnterpriseSecret(first, 'connection:a')).toBe('test-upstream-secret');
  });
  it('refuses ciphertext relocation and tampering without exposing plaintext', async () => {
    const sealed = await sealEnterpriseSecret('test-upstream-secret', 'connection:a');
    await expect(openEnterpriseSecret(sealed, 'connection:b')).rejects.toThrow('SSO_CUSTODY_UNAVAILABLE');
    const envelope = JSON.parse(sealed); envelope.tag = randomBytes(16).toString('base64url');
    await expect(openEnterpriseSecret(JSON.stringify(envelope), 'connection:a')).rejects.toThrow('SSO_CUSTODY_UNAVAILABLE');
  });
  it('decrypts overlapping old key versions and refuses a retired key', async () => {
    const sealed = await sealEnterpriseSecret('test-upstream-secret', 'connection:a');
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'b', keys: { a: keyA, b: keyB } });
    expect(await openEnterpriseSecret(sealed, 'connection:a')).toBe('test-upstream-secret');
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'b', keys: { b: keyB } });
    await expect(openEnterpriseSecret(sealed, 'connection:a')).rejects.toThrow('SSO_CUSTODY_UNAVAILABLE');
  });
  it('requires an explicit custody provider', async () => {
    delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER;
    await expect(sealEnterpriseSecret('secret', 'connection:a')).rejects.toThrow('SSO_CUSTODY_PROVIDER_REQUIRED');
  });
  it('generates an encrypted RSA SP key with only its public certificate outside custody', async () => {
    const generated = await createEnterpriseSpKey('connection-a');
    const cert = new X509Certificate(generated.publicCertificate);
    expect(cert.publicKey.asymmetricKeyType).toBe('rsa');
    expect(cert.publicKey.asymmetricKeyDetails?.modulusLength).toBeGreaterThanOrEqual(2048);
    expect(generated.encryptedSecret).not.toContain('PRIVATE KEY');
    const keys = JSON.parse(await openEnterpriseSecret(generated.encryptedSecret, 'connection:connection-a'));
    expect(keys.certificate).toBe(generated.publicCertificate);
  });
});
