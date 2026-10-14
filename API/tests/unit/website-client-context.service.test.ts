import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { matchesWebsiteRefreshContext, migrateWebsiteRefreshFamily } from '../../src/services/website-client-context.service.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';
const saved = process.env.DATABASE_URL;
beforeEach(() => { process.env.DATABASE_URL = 'postgresql://unit.invalid/database'; });
afterEach(() => { if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved; });
const domain = 'product.example.com/service';
const context = { domain, configUrl: 'https://product.example.com/service/config', clientId: 'domain-record' };
const credential = 'a'.repeat(64);
function fixture(active = true) {
  const db = { clientDomain: { findUnique: vi.fn(async () => ({ id: context.clientId, status: 'active',
    secrets: active ? [{ secretDigest: digestDomainClientHash(credential), hashPrefix: credential.slice(0, 12) }] : [] })) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 3 })) },
    debugLoginGrant: { updateMany: vi.fn(async () => ({ count: 1 })) } };
  return db;
}
describe('website client context transition', () => {
  it('accepts a valid old binding only for the same authenticated stable domain and exact config', async () => {
    const db = fixture(); const row = { ...context, clientId: credential };
    expect(await matchesWebsiteRefreshContext(row, context, db as unknown as PrismaClient)).toBe(true);
    expect(await matchesWebsiteRefreshContext(row, { ...context, configUrl: context.configUrl + '?other=1' }, db as unknown as PrismaClient)).toBe(false);
    expect(await matchesWebsiteRefreshContext(row, { ...context, clientId: 'another-product' }, db as unknown as PrismaClient)).toBe(false);
  });
  it('never revives a binding whose original domain secret was revoked', async () => {
    const db = fixture(false); const row = { ...context, clientId: credential, familyId: 'family', userId: 'subject' };
    expect(await matchesWebsiteRefreshContext(row, context, db as unknown as PrismaClient)).toBe(false);
    await migrateWebsiteRefreshFamily(row, context, db as unknown as PrismaClient);
    expect(db.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(db.debugLoginGrant.updateMany).not.toHaveBeenCalled();
  });
  it('converts all family edges and debug grants to one stable id without changing proof, epoch or scope', async () => {
    const db = fixture(); const row = { ...context, clientId: credential, familyId: 'family', userId: 'subject' };
    await migrateWebsiteRefreshFamily(row, context, db as unknown as PrismaClient);
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({ where: { familyId: 'family', userId: 'subject', domain, clientId: credential }, data: { clientId: 'domain-record' } });
    expect(db.debugLoginGrant.updateMany).toHaveBeenCalledWith({ where: { sourceFamilyId: 'family', userId: 'subject', domain, clientId: credential }, data: { clientId: 'domain-record' } });
  });
  it('preserves a dependency failure instead of presenting it as an invalid session', async () => {
    const db = fixture(); const outage = new Error('synthetic unavailable'); db.clientDomain.findUnique.mockRejectedValue(outage);
    await expect(matchesWebsiteRefreshContext({ ...context, clientId: credential }, context, db as unknown as PrismaClient)).rejects.toBe(outage);
  });
});
