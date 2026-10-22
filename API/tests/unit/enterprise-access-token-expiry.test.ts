import { decodeJwt } from 'jose';
import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueTokenPairForUser } from '../../src/services/token.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';

const source = vi.hoisted(() => ({ proof: vi.fn() }));
vi.mock('../../src/services/token-assurance.service.js', () => ({ resolveTokenFamilyAssurance: source.proof }));
vi.mock('../../src/services/domain-role.service.js', () => ({ ensureDomainRoleForUser: async () => ({ role: 'USER' }), isPlatformSuperuser: async () => false }));
const db = { user: { findUnique: async () => ({ email: 'person@example.com', tokenVersion: 1 }) } } as unknown as PrismaClient;
const config = { domain: 'expiry.example.com', org_features: { enabled: false } } as ClientConfig;
const issue = () => issueTokenPairForUser({ config, configUrl: 'https://expiry.example.com/config', clientId: 'client',
  refreshToken: 'opaque-refresh', refreshTokenExpiresInSeconds: 3600, userId: 'person' },
{ prisma: db, adminPrisma: db, sharedSecret: 'test-secret-not-a-production-key', accessTokenTtl: '15m' });
afterEach(() => { vi.useRealTimers(); source.proof.mockReset(); });
describe('access token lifetime cannot outlive authoritative proof', () => {
  it('caps the signed JWT and advertised lifetime to the same absolute proof boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-18T00:00:00.250Z'));
    source.proof.mockResolvedValue({ assuranceId: 'assurance', assuranceExpiresAt: '2026-10-18T00:00:23.900Z', globalAccountControl: false });
    const result = await issue(); const jwt = decodeJwt(result.accessToken);
    expect(result.expiresInSeconds).toBe(23); expect(jwt.exp).toBe(Date.parse('2026-10-18T00:00:23Z') / 1000);
    expect((jwt.exp ?? 0) * 1000).toBeLessThanOrEqual(Date.parse(result.assuranceExpiresAt ?? ''));
    expect((jwt.exp ?? 0) - (jwt.iat ?? 0)).toBe(result.expiresInSeconds);
  });
  it('retains the configured shorter lifetime when the proof lasts longer', async () => {
    source.proof.mockResolvedValue({ assuranceId: 'assurance', assuranceExpiresAt: new Date(Date.now() + 3600000).toISOString(), globalAccountControl: false });
    const result = await issue(); expect(result.expiresInSeconds).toBe(900);
    const jwt = decodeJwt(result.accessToken); expect((jwt.exp ?? 0) - (jwt.iat ?? 0)).toBeLessThanOrEqual(900);
  });
  it.each(['invalid', '2000-01-01T00:00:00Z'])('refuses invalid or already expired proof boundaries (%s)', async (expires) => {
    source.proof.mockResolvedValue({ assuranceId: 'assurance', assuranceExpiresAt: expires, globalAccountControl: false });
    await expect(issue()).rejects.toThrow('INVALID_SESSION_ASSURANCE');
  });
});
