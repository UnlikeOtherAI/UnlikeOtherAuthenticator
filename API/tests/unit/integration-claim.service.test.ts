import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeClaim,
  createClaimToken,
  hashClaimToken,
  peekClaim,
  replaceClaimToken,
  sweepExpiredClaims,
} from '../../src/services/integration-claim.service.js';
import {
  encryptClaimSecret,
  type EncryptedClaimSecret,
} from '../../src/utils/claim-secret-crypto.js';

const sharedSecret = 'test-shared-secret-with-enough-length';

type Row = {
  id: string;
  integrationId: string;
  tokenHash: string;
  encryptedSecret: Uint8Array | null;
  encryptionIv: Uint8Array | null;
  encryptionTag: Uint8Array | null;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

function makePrisma(initial: Row[] = []): {
  prisma: Parameters<typeof createClaimToken>[1] extends { prisma?: infer P } ? P : never;
  rows: Row[];
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  deleteManySpy: ReturnType<typeof vi.fn>;
  updateManySpy: ReturnType<typeof vi.fn>;
} {
  const rows: Row[] = [...initial];

  const create = vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt' | 'usedAt'> }) => {
    const row: Row = {
      id: `row-${rows.length + 1}`,
      createdAt: new Date(),
      usedAt: null,
      ...data,
    } as Row;
    rows.push(row);
    return row;
  });

  const findUnique = vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
    return rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
  });

  const findFirst = vi.fn(
    async ({
      where,
      orderBy: _orderBy,
    }: {
      where: { integrationId: string; usedAt: null };
      orderBy?: unknown;
    }) => {
      return (
        rows.find((r) => r.integrationId === where.integrationId && r.usedAt === null) ?? null
      );
    },
  );

  const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const idx = rows.findIndex((r) => r.id === where.id);
    if (idx < 0) throw new Error('row not found');
    rows[idx] = { ...rows[idx], ...data };
    return rows[idx];
  });

  const deleteMany = vi.fn(
    async ({
      where,
    }: {
      where: { integrationId: string; usedAt: null };
    }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].integrationId === where.integrationId && rows[i].usedAt === null) {
          rows.splice(i, 1);
        }
      }
      return { count: before - rows.length };
    },
  );

  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { expiresAt: { lt: Date }; encryptedSecret: { not: null } };
      data: Partial<Row>;
    }) => {
      let count = 0;
      for (const row of rows) {
        if (row.expiresAt.getTime() < where.expiresAt.lt.getTime() && row.encryptedSecret) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  );

  const prisma = {
    integrationClaimToken: { create, findUnique, findFirst, update, deleteMany, updateMany },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
      integrationClaimToken: { create, findUnique, findFirst, update, deleteMany, updateMany },
    }),
  } as unknown as Parameters<typeof createClaimToken>[1] extends { prisma?: infer P } ? P : never;

  return { prisma, rows, createSpy: create, updateSpy: update, deleteManySpy: deleteMany, updateManySpy: updateMany };
}

describe('integration-claim.service', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
  });

  afterEach(() => {
    if (originalSharedSecret === undefined) {
      Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    } else {
      process.env.SHARED_SECRET = originalSharedSecret;
    }
  });

  describe('createClaimToken', () => {
    it('persists an encrypted secret and returns the raw token', async () => {
      const { prisma, rows, createSpy } = makePrisma();
      const clientSecret = 'client-secret-min-32-bytes-of-entropy-xx';

      const result = await createClaimToken(
        { integrationId: 'int-1', clientSecret },
        { prisma, sharedSecret },
      );

      expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.tokenHash).toBe(hashClaimToken(result.rawToken));
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      expect(createSpy).toHaveBeenCalledTimes(1);
      const stored = rows[0];
      expect(stored.tokenHash).toBe(result.tokenHash);
      expect(stored.encryptedSecret).toBeInstanceOf(Uint8Array);
      expect(stored.encryptionIv).toBeInstanceOf(Uint8Array);
      expect(stored.encryptionTag).toBeInstanceOf(Uint8Array);

      // The stored ciphertext must never equal the plaintext.
      const ciphertext = Buffer.from(stored.encryptedSecret as Uint8Array).toString('utf8');
      expect(ciphertext).not.toContain('client-secret');
    });
  });

  describe('peekClaim', () => {
    it('reports missing for unknown tokens', async () => {
      const { prisma } = makePrisma();
      const state = await peekClaim('unknown-raw-token', { prisma });
      expect(state).toEqual({ state: 'missing' });
    });

    it('reports valid when unused and not expired', async () => {
      const { prisma } = makePrisma();
      const created = await createClaimToken(
        { integrationId: 'int-1', clientSecret: 'secret-value-plenty-long-enough-a' },
        { prisma, sharedSecret },
      );

      const state = await peekClaim(created.rawToken, { prisma });
      expect(state).toMatchObject({ state: 'valid', integrationId: 'int-1' });
    });

    it('reports expired when past expiresAt', async () => {
      const { prisma } = makePrisma();
      const created = await createClaimToken(
        { integrationId: 'int-1', clientSecret: 'secret-value-plenty-long-enough-a', ttlMs: 1 },
        { prisma, sharedSecret },
      );
      await new Promise((r) => setTimeout(r, 5));

      const state = await peekClaim(created.rawToken, { prisma });
      expect(state).toEqual({ state: 'expired' });
    });
  });

  describe('consumeClaim', () => {
    it('returns the plaintext secret and marks the row used', async () => {
      const { prisma, rows } = makePrisma();
      const plaintext = 'actual-client-secret-stored-encrypted-zz';
      const created = await createClaimToken(
        { integrationId: 'int-1', clientSecret: plaintext },
        { prisma, sharedSecret },
      );

      const result = await consumeClaim(created.rawToken, { prisma, sharedSecret });
      expect(result).toMatchObject({ state: 'consumed', integrationId: 'int-1' });
      if (result.state !== 'consumed') throw new Error('expected consumed');
      expect(result.clientSecret).toBe(plaintext);

      expect(rows[0].usedAt).not.toBeNull();
      expect(rows[0].encryptedSecret).toBeNull();
      expect(rows[0].encryptionIv).toBeNull();
      expect(rows[0].encryptionTag).toBeNull();
    });

    it('rejects a second consume of the same token', async () => {
      const { prisma } = makePrisma();
      const created = await createClaimToken(
        { integrationId: 'int-1', clientSecret: 'actual-client-secret-stored-encrypted-zz' },
        { prisma, sharedSecret },
      );
      await consumeClaim(created.rawToken, { prisma, sharedSecret });

      const second = await consumeClaim(created.rawToken, { prisma, sharedSecret });
      expect(second).toEqual({ state: 'already_used' });
    });
  });

  describe('replaceClaimToken', () => {
    it('deletes prior unused tokens and creates a fresh row', async () => {
      const { prisma, rows } = makePrisma();
      await createClaimToken(
        { integrationId: 'int-1', clientSecret: 'secret-value-plenty-long-enough-a' },
        { prisma, sharedSecret },
      );
      expect(rows).toHaveLength(1);

      const replaced = await replaceClaimToken(
        { integrationId: 'int-1', clientSecret: 'secret-value-plenty-long-enough-b' },
        { prisma, sharedSecret },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(replaced.tokenHash);
    });
  });

  describe('sweepExpiredClaims', () => {
    it('nulls encrypted material on expired rows and leaves live rows untouched', async () => {
      const enc = encryptClaimSecret('long-enough-plaintext-secret-value', { sharedSecret });
      const now = new Date('2026-04-22T10:00:00Z');
      const expired: EncryptedClaimSecret = enc;

      const rows: Row[] = [
        {
          id: 'expired',
          integrationId: 'int-1',
          tokenHash: 'h1',
          encryptedSecret: expired.ciphertext,
          encryptionIv: expired.iv,
          encryptionTag: expired.tag,
          expiresAt: new Date('2026-04-22T09:00:00Z'),
          usedAt: null,
          createdAt: new Date('2026-04-21T10:00:00Z'),
        },
        {
          id: 'live',
          integrationId: 'int-2',
          tokenHash: 'h2',
          encryptedSecret: expired.ciphertext,
          encryptionIv: expired.iv,
          encryptionTag: expired.tag,
          expiresAt: new Date('2026-04-22T20:00:00Z'),
          usedAt: null,
          createdAt: new Date('2026-04-22T09:00:00Z'),
        },
      ];

      const { prisma } = makePrisma(rows);
      const result = await sweepExpiredClaims({ prisma, now });
      expect(result).toEqual({ nulled: 1 });

      expect(rows.find((r) => r.id === 'expired')?.encryptedSecret).toBeNull();
      expect(rows.find((r) => r.id === 'live')?.encryptedSecret).toBeInstanceOf(Uint8Array);
    });
  });
});
