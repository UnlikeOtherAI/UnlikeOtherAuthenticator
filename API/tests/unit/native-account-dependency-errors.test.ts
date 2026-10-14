import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { getPublicBaseUrl } from '../../src/config/env.js';
import { verifyPublicAccountToken } from '../../src/services/oauth/account.service.js';
const mocks = vi.hoisted(() => ({ keys: vi.fn(), client: vi.fn(), config: vi.fn() }));
vi.mock('../../src/services/oauth/access-token.service.js', () => ({
  getAccessTokenPublicJwks: mocks.keys,
}));
vi.mock('../../src/services/oauth/client.service.js', () => ({ getOAuthClient: mocks.client }));
vi.mock('../../src/services/oauth/config.service.js', () => ({
  buildMcpClientConfig: mocks.config,
}));
let privateKey: KeyLike, publicJwk: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  Object.assign(publicJwk, { kid: 'native-account-fixture', use: 'sig', alg: 'RS256' });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.keys.mockResolvedValue({ keys: [publicJwk] });
  mocks.client.mockResolvedValue({
    clientId: 'native',
    redirectUris: ['http://127.0.0.1/callback'],
    scopes: ['openid', 'profile'],
    nativeApp: null,
  });
  mocks.config.mockReturnValue({ domain: 'client.example.com' });
});
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    token_use: 'public_oauth',
    client_id: 'native',
    domain: 'client.example.com',
    tv: 3,
    scope: 'profile',
    ...overrides,
  })
    .setSubject('person')
    .setIssuer(getPublicBaseUrl())
    .setAudience(getPublicBaseUrl())
    .setIssuedAt()
    .setExpirationTime('5m')
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'native-account-fixture' })
    .sign(privateKey);
}
describe('native account credential versus dependency failures', () => {
  it('preserves a current-client DB outage for the generic server-error path', async () => {
    const outage = new Error('synthetic database unavailable');
    mocks.client.mockRejectedValue(outage);
    await expect(verifyPublicAccountToken('Bearer ' + (await token()), 'profile')).rejects.toBe(
      outage,
    );
  });
  it('preserves trusted key configuration and native policy failures', async () => {
    const jwt = await token();
    const outage = new Error('synthetic verification configuration unavailable');
    mocks.keys.mockRejectedValueOnce(outage);
    await expect(verifyPublicAccountToken('Bearer ' + jwt, 'profile')).rejects.toBe(outage);
    mocks.config.mockImplementationOnce(() => {
      throw outage;
    });
    await expect(verifyPublicAccountToken('Bearer ' + jwt, 'profile')).rejects.toBe(outage);
  });
  it('still refuses a revoked client after a valid signature', async () => {
    mocks.client.mockResolvedValue(null);
    await expect(
      verifyPublicAccountToken('Bearer ' + (await token()), 'profile'),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
  it('refuses an altered signature before any current-client read', async () => {
    const parts = (await token()).split('.');
    parts[2] = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
    await expect(
      verifyPublicAccountToken('Bearer ' + parts.join('.'), 'profile'),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it('rejects malformed claims and missing required scope without treating them as outages', async () => {
    await expect(
      verifyPublicAccountToken('Bearer ' + (await token({ tv: '3' })), 'profile'),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      verifyPublicAccountToken('Bearer ' + (await token({ scope: 'openid' })), 'profile'),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      verifyPublicAccountToken(
        'Bearer ' + (await token({ domain: 'other.example.com' })),
        'profile',
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
