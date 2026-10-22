import { randomBytes, randomUUID } from 'node:crypto';
import type { OrgSsoConnection, OrgSsoFlow } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localEnterpriseOidcProvider } from '../helpers/enterprise-oidc-provider.js';
import { createEnterpriseSpKey } from '../../src/services/org-sso-sp-key.service.js';
import { openEnterpriseSecret, sealEnterpriseSecret } from '../../src/services/enterprise-secret.service.js';
import { enterpriseOidcAuthorize, validateEnterpriseOidcCallback } from '../../src/services/org-sso-oidc.service.js';
import { resolveEnterpriseConfiguration } from '../../src/services/org-sso-configuration.service.js';
import { getPublicBaseUrl } from '../../src/config/env.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/services/enterprise-http.service.js', () => ({ enterpriseFetch: transport.fetch }));
describe('actual HTTPS OIDC provider wire and signed token engine', () => {
  let provider: Awaited<ReturnType<typeof localEnterpriseOidcProvider>>; let connection: OrgSsoConnection;
  const id = randomUUID();
  const priorProvider = process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; const priorRing = process.env.ENTERPRISE_SSO_KEYRING;
  async function authorize() {
    const verifier = randomBytes(32).toString('base64url'); const flowId = randomBytes(32).toString('base64url');
    const flow = { id: flowId, nonce: randomBytes(32).toString('base64url'),
      encryptedVerifier: await sealEnterpriseSecret(verifier, `flow:${flowId}`) } as OrgSsoFlow;
    const redirect = await provider.wire(enterpriseOidcAuthorize(connection, flow, verifier));
    expect(redirect.status).toBe(302);
    const callback = new URL(String(redirect.headers.location)); expect(callback.searchParams.get('state')).toBe(flow.id);
    return { flow, input: { code: callback.searchParams.get('code') ?? '', iss: callback.searchParams.get('iss') ?? '' } };
  }
  beforeAll(async () => {
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: { test: randomBytes(32).toString('base64') } });
    const tls = await createEnterpriseSpKey('oidc-wire-tls');
    const keys = JSON.parse(await openEnterpriseSecret(tls.encryptedSecret, 'connection:oidc-wire-tls')) as { private_key: string; certificate: string };
    provider = await localEnterpriseOidcProvider(keys, `${getPublicBaseUrl()}/sso/oidc/${id}/callback`);
    // Only outbound test transport trusts this exact local fixture. Production SSRF/TLS code is unchanged.
    transport.fetch.mockImplementation(async (url: string, origins: readonly string[], options?: Parameters<typeof provider.wire>[1]) => {
      if (!origins.includes(provider.issuer)) throw new Error('Untrusted fixture origin');
      const result = await provider.wire(url, options); if (result.status !== 200) throw new Error('Provider refused request');
      return result.body;
    });
    const configuration = await resolveEnterpriseConfiguration('other_oidc', 'oidc', { issuer: provider.issuer,
      client_id: provider.clientId, tenant: { claim: 'tenant', value: 'exact-tenant' } });
    connection = { id, preset: 'other_oidc', protocol: 'oidc', configuration,
      encryptedSecret: await sealEnterpriseSecret(provider.secret, `connection:${id}`) } as OrgSsoConnection;
  }, 60000);
  afterAll(async () => {
    await provider?.close(); transport.fetch.mockReset();
    if (priorProvider === undefined) delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = priorProvider;
    if (priorRing === undefined) delete process.env.ENTERPRISE_SSO_KEYRING; else process.env.ENTERPRISE_SSO_KEYRING = priorRing;
  });
  it('performs actual discovery/authorize/token/JWKS exchanges with PKCE and mixed-key RSA validation', async () => {
    provider.state.claims = { aud: [provider.clientId, 'another-valid-audience'], azp: provider.clientId };
    const { flow, input } = await authorize();
    expect(await validateEnterpriseOidcCallback(connection, flow, input)).toMatchObject({ subject: 'stable-subject', tenant: 'exact-tenant', authenticatedAt: null });
    await expect(validateEnterpriseOidcCallback(connection, flow, input)).rejects.toThrow(); // Real provider code consumption.
  });
  it('refuses actual signed tenant/nonce/audience/azp substitution and unknown-key or foreign signatures', async () => {
    for (const claims of [{ tenant: 'foreign' }, { nonce: 'foreign' }, { aud: 'foreign' },
      { aud: [provider.clientId, 'other'], azp: 'foreign' }]) {
      provider.state.claims = claims; const { flow, input } = await authorize();
      await expect(validateEnterpriseOidcCallback(connection, flow, input)).rejects.toThrow();
    }
    provider.state.claims = {}; provider.state.signingKid = 'unknown-key';
    let started = await authorize(); await expect(validateEnterpriseOidcCallback(connection, started.flow, started.input)).rejects.toThrow();
    provider.state.signingKid = 'signing-key'; provider.state.wrongSignature = true;
    started = await authorize(); await expect(validateEnterpriseOidcCallback(connection, started.flow, started.input)).rejects.toThrow();
    provider.state.wrongSignature = false; provider.state.duplicateKid = true;
    started = await authorize(); await expect(validateEnterpriseOidcCallback(connection, started.flow, started.input)).rejects.toThrow();
    provider.state.duplicateKid = false;
  });
  it('requires the original PKCE verifier and preserves signed authentication age instead of rebasing callback time', async () => {
    provider.state.claims = { auth_time: Math.floor(Date.now() / 1000) - 3600 };
    let started = await authorize();
    const identity = await validateEnterpriseOidcCallback(connection, started.flow, started.input);
    expect(identity.authenticatedAt?.getTime()).toBeLessThan(Date.now() - 3500000);
    started = await authorize();
    await expect(validateEnterpriseOidcCallback(connection, { ...started.flow,
      encryptedVerifier: await sealEnterpriseSecret('wrong-verifier', `flow:${started.flow.id}`) }, started.input)).rejects.toThrow();
    const original = connection.configuration;
    connection = { ...connection, configuration: { ...(original as object), max_age: 0 } };
    started = await authorize(); await expect(validateEnterpriseOidcCallback(connection, started.flow, started.input)).rejects.toThrow('SSO_AUTH_TIME_REQUIRED');
    connection = { ...connection, configuration: original };
  });
});
