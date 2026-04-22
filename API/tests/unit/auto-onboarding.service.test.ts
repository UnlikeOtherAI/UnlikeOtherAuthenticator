import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readOptInFields,
  tryAutoOnboard,
} from '../../src/services/auto-onboarding.service.js';
import {
  baseClientConfigPayload,
  signTestConfigJwt,
  testConfigJwks,
  TEST_CONFIG_KID,
} from '../helpers/test-config.js';

const integrationRequestMocks = vi.hoisted(() => ({
  findOpenIntegrationRequest: vi.fn(),
  upsertPendingIntegrationRequest: vi.fn(),
}));

vi.mock('../../src/services/integration-request.service.js', () => integrationRequestMocks);

const CONFIG_URL = 'https://client.example.com/config';

describe('readOptInFields', () => {
  it('returns null when the JWT is missing jwks_url or contact_email', async () => {
    const jwt = await signTestConfigJwt(baseClientConfigPayload());
    expect(readOptInFields(jwt)).toBeNull();
  });

  it('returns the opt-in fields when present', async () => {
    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        jwks_url: 'https://client.example.com/.well-known/jwks.json',
        contact_email: 'ops@client.example.com',
      }),
    );
    expect(readOptInFields(jwt)).toEqual({
      domain: 'client.example.com',
      jwksUrl: 'https://client.example.com/.well-known/jwks.json',
      contactEmail: 'ops@client.example.com',
    });
  });

  it('rejects an invalid email address', async () => {
    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        jwks_url: 'https://client.example.com/.well-known/jwks.json',
        contact_email: 'not-an-email',
      }),
    );
    expect(readOptInFields(jwt)).toBeNull();
  });
});

describe('tryAutoOnboard', () => {
  beforeEach(() => {
    integrationRequestMocks.findOpenIntegrationRequest.mockReset().mockResolvedValue(null);
    integrationRequestMocks.upsertPendingIntegrationRequest
      .mockReset()
      .mockImplementation(async () => ({
        kind: 'created',
        row: { id: 'req-1' },
      }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function stubFetchWithJwks(): Promise<ReturnType<typeof vi.fn>> {
    const jwks = await testConfigJwks();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('creates a pending request when fingerprint has never been seen', async () => {
    await stubFetchWithJwks();

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        jwks_url: 'https://client.example.com/.well-known/jwks.json',
        contact_email: 'ops@client.example.com',
      }),
    );

    const outcome = await tryAutoOnboard(jwt, CONFIG_URL);

    expect(outcome).toMatchObject({
      kind: 'pending',
      domain: 'client.example.com',
      contactEmail: 'ops@client.example.com',
      result: 'created',
    });
    expect(integrationRequestMocks.upsertPendingIntegrationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'client.example.com',
        kid: TEST_CONFIG_KID,
        jwksUrl: 'https://client.example.com/.well-known/jwks.json',
        contactEmail: 'ops@client.example.com',
        configUrl: CONFIG_URL,
      }),
    );
  });

  it('short-circuits with declined when a DECLINED row exists', async () => {
    await stubFetchWithJwks();
    integrationRequestMocks.findOpenIntegrationRequest.mockResolvedValue({
      id: 'req-old',
      domain: 'client.example.com',
      status: 'DECLINED',
    });

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        jwks_url: 'https://client.example.com/.well-known/jwks.json',
        contact_email: 'ops@client.example.com',
      }),
    );

    const outcome = await tryAutoOnboard(jwt, CONFIG_URL);

    expect(outcome.kind).toBe('declined');
    expect(integrationRequestMocks.upsertPendingIntegrationRequest).not.toHaveBeenCalled();
  });

  it('rejects when jwks_url hostname does not match the domain claim', async () => {
    await stubFetchWithJwks();

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        jwks_url: 'https://evil.example.org/.well-known/jwks.json',
        contact_email: 'ops@client.example.com',
      }),
    );

    await expect(tryAutoOnboard(jwt, CONFIG_URL)).rejects.toMatchObject({
      statusCode: 400,
      message: 'INTEGRATION_JWKS_HOST_MISMATCH',
    });
    expect(integrationRequestMocks.upsertPendingIntegrationRequest).not.toHaveBeenCalled();
  });

  it('rejects when the JWKS does not contain the JWT kid', async () => {
    const jwks = { keys: [{ kty: 'RSA', kid: 'some-other-kid', n: 'nnn', e: 'AQAB' }] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        jwks_url: 'https://client.example.com/.well-known/jwks.json',
        contact_email: 'ops@client.example.com',
      }),
    );

    await expect(tryAutoOnboard(jwt, CONFIG_URL)).rejects.toMatchObject({
      statusCode: 400,
      message: 'INTEGRATION_KID_NOT_IN_JWKS',
    });
  });

  it('rejects when the partner JWKS cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        jwks_url: 'https://client.example.com/.well-known/jwks.json',
        contact_email: 'ops@client.example.com',
      }),
    );

    await expect(tryAutoOnboard(jwt, CONFIG_URL)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('reports "unchanged" when the same fingerprint+jwks_url+contact_email is re-submitted', async () => {
    await stubFetchWithJwks();
    integrationRequestMocks.upsertPendingIntegrationRequest.mockResolvedValue({
      kind: 'unchanged',
      row: { id: 'req-1' },
    });

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        jwks_url: 'https://client.example.com/.well-known/jwks.json',
        contact_email: 'ops@client.example.com',
      }),
    );

    const outcome = await tryAutoOnboard(jwt, CONFIG_URL);
    expect(outcome).toMatchObject({ kind: 'pending', result: 'unchanged' });
  });
});
