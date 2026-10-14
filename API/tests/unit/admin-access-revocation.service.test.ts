import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { assertAdminAccessNotRevoked, revokeAdminAccess } from '../../src/services/admin-access-revocation.service.js';

describe('exact Admin bearer logout', () => {
  it('stores only a digest, rejects that bearer, and preserves a different same-user session', async () => {
    const signer = new TextEncoder().encode('synthetic-admin-test-signing-material');
    const a = await new SignJWT({}).setSubject('person').setJti('a').setExpirationTime('30m').setProtectedHeader({ alg: 'HS256' }).sign(signer);
    const b = await new SignJWT({}).setSubject('person').setJti('b').setExpirationTime('30m').setProtectedHeader({ alg: 'HS256' }).sign(signer);
    const rows = new Map<string, { tokenHash: string; expiresAt: Date }>();
    const store = { findUnique: vi.fn(async ({ where }) => rows.get(where.tokenHash) ?? null),
      upsert: vi.fn(async ({ create }) => { rows.set(create.tokenHash, create); return create; }) };
    const db = { adminAccessTokenRevocation: store } as unknown as PrismaClient;
    await assertAdminAccessNotRevoked(a, db);
    await revokeAdminAccess(a, db);
    await revokeAdminAccess(a, db);
    expect(rows.size).toBe(1);
    expect([...rows.keys()][0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify([...rows.values()])).not.toContain(a);
    expect([...rows.values()][0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(assertAdminAccessNotRevoked(a, db)).rejects.toMatchObject({ statusCode: 401 });
    await expect(assertAdminAccessNotRevoked(b, db)).resolves.toBeUndefined();
  });
  it('preserves store outages for the generic5xx path', async () => {
    const unavailable = new Error('synthetic unavailable');
    const db = { adminAccessTokenRevocation: { findUnique: vi.fn().mockRejectedValue(unavailable) } } as unknown as PrismaClient;
    await expect(assertAdminAccessNotRevoked('synthetic', db)).rejects.toBe(unavailable);
  });
});
