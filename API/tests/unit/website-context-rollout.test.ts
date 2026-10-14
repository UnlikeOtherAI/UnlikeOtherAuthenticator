import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertWebsiteContextReaderFloor } from '../../src/services/website-context-reader-floor.js';
import { matchesWebsiteRefreshContext, migrateWebsiteRefreshFamily, websiteRefreshStorageClientId } from '../../src/services/website-client-context.service.js';
import { exchangeRefreshToken, issueRefreshToken, revokeRefreshTokenFamily } from '../../src/services/refresh-token.service.js';
import { matchesRefreshTokenContext } from '../../src/services/refresh-token-replay.service.js';
import { createRefreshFixture, TEST_REFRESH_CONTEXT as context, TEST_REFRESH_SHARED_SECRET as sharedSecret } from '../helpers/fake-refresh-token-store.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';

const credential = 'a'.repeat(64);
const digest = 'sha256:' + '1'.repeat(64);
const savedDatabase = process.env.DATABASE_URL;
const savedPhase = process.env.WEBSITE_CLIENT_CONTEXT_PHASE;
beforeEach(() => { process.env.DATABASE_URL = 'postgresql://website-rollout.unit.invalid/db'; process.env.WEBSITE_CLIENT_CONTEXT_PHASE = 'bridge'; });
afterEach(() => {
  if (savedDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDatabase;
  if (savedPhase === undefined) delete process.env.WEBSITE_CLIENT_CONTEXT_PHASE; else process.env.WEBSITE_CLIENT_CONTEXT_PHASE = savedPhase;
});
function domainStore() {
  return { findUnique: vi.fn(async () => ({ id: context.clientId, status: 'active',
    secrets: [{ secretDigest: digestDomainClientHash(credential), hashPrefix: 'synthetic' }] })) };
}
function revision(mode: string | null = 'stable', image = digest) {
  return { spec: { containers: [{ env: mode ? [{ name: 'WEBSITE_CLIENT_CONTEXT_PHASE', value: mode }] : [] }] },
    status: { imageDigest: 'registry.example.com/api@' + image } };
}

describe('website two-phase client context rollout', () => {
  it('keeps new website refresh rows compatible with the old exact-context reader', async () => {
    const create = vi.fn(async () => ({ id: 'new' }));
    const db = { clientDomain: domainStore(), refreshToken: { create } } as unknown as PrismaClient;
    await issueRefreshToken({ ...context, websiteCredential: credential, userId: 'user-1', twoFaCompleted: false }, { prisma: db, sharedSecret });
    const stored = create.mock.calls[0] as unknown as [{ data: typeof context }];
    expect(stored[0].data.clientId).toBe(credential);
    expect(matchesRefreshTokenContext(stored[0].data, { ...context, clientId: credential })).toBe(true);
    expect(await matchesWebsiteRefreshContext(stored[0].data, context, db)).toBe(true);
  });

  it('rotates and replays an old family without rewriting any family edge', async () => {
    const now = new Date('2026-10-14T12:00:00Z');
    const { store, initial } = await createRefreshFixture(now);
    Object.assign(store.client, { clientDomain: domainStore() });
    for (const row of store.rows.values()) row.clientId = credential;
    const rotate = () => exchangeRefreshToken({ ...context, refreshToken: initial.refreshToken },
      { prisma: store.client, sharedSecret, now: () => new Date(now.getTime() + 1000) });
    const successor = await rotate();
    expect((await rotate()).refreshToken).toBe(successor.refreshToken);
    expect([...store.rows.values()].every(row => row.clientId === credential)).toBe(true);
    expect(matchesRefreshTokenContext(store.byRawToken(successor.refreshToken), { ...context, clientId: credential })).toBe(true);
    expect(await matchesWebsiteRefreshContext(store.byRawToken(successor.refreshToken), context, store.client)).toBe(true);
    await revokeRefreshTokenFamily({ ...context, refreshToken: successor.refreshToken }, { prisma: store.client, sharedSecret });
    expect([...store.rows.values()].every(row => row.clientId === credential)).toBe(true);
  });

  it('never converts families while bridge is active', async () => {
    const updates = vi.fn();
    const db = { clientDomain: domainStore(), refreshToken: { updateMany: updates }, debugLoginGrant: { updateMany: updates } } as unknown as PrismaClient;
    await expect(migrateWebsiteRefreshFamily({ ...context, clientId: credential, familyId: 'family', userId: 'user' }, context, db))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(updates).not.toHaveBeenCalled();
  });

  it('fails closed on exact config/domain differences and revoked legacy credentials', async () => {
    const db = { clientDomain: domainStore() } as unknown as PrismaClient;
    const row = { ...context, clientId: credential };
    expect(await matchesWebsiteRefreshContext(row, { ...context, configUrl: context.configUrl + '?other=1' }, db)).toBe(false);
    expect(await matchesWebsiteRefreshContext(row, { ...context, domain: 'other.example.com' }, db)).toBe(false);
    vi.mocked(db.clientDomain.findUnique).mockResolvedValue(null);
    expect(await matchesWebsiteRefreshContext(row, context, db)).toBe(false);
  });

  it('uses stable storage only in phase two and refuses legacy online conversion', async () => {
    process.env.WEBSITE_CLIENT_CONTEXT_PHASE = 'stable';
    const db = { clientDomain: domainStore() } as unknown as PrismaClient;
    expect(await websiteRefreshStorageClientId(context, credential, db)).toBe(context.clientId);
    await expect(matchesWebsiteRefreshContext({ ...context, clientId: credential }, context, db)).rejects.toMatchObject({ statusCode: 503 });
    expect(await matchesWebsiteRefreshContext(context, context, db)).toBe(true);
  });

  it.each([[], [revision(null)], [revision('bridge')], [revision('stable', 'sha256:' + '2'.repeat(64))],
    [revision(), { ...revision(), metadata: { deletionTimestamp: '2026-10-14' } }]])('refuses an unverified, legacy, bridge-writer or retiring revision inventory', (inventory) => {
    expect(() => assertWebsiteContextReaderFloor(inventory, [digest], true)).toThrow();
  });

  it('permits only reviewed stable writers for final cleanup, including retained zero-traffic revisions', () => {
    expect(() => assertWebsiteContextReaderFloor([revision(), revision()], [digest], true)).not.toThrow();
    expect(() => assertWebsiteContextReaderFloor([revision('bridge'), revision()], [digest])).not.toThrow();
    expect(() => assertWebsiteContextReaderFloor([revision(), revision(null)], [digest], true)).toThrow();
  });
});
