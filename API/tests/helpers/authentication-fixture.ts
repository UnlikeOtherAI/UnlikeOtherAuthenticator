import { randomUUID } from 'node:crypto';
import type { AuthenticationEvidence } from '@prisma/client';
import { vi } from 'vitest';

/** Explicit pre-enrolment policy for legacy route fixtures. No advertised proof is accepted here. */
export function legacyCredentialStores() {
  return {
    enterpriseProductReadiness: { findUnique: vi.fn().mockResolvedValue(null) },
    orgSsoPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
    externalIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
    organisationEmailDomain: { findFirst: vi.fn().mockResolvedValue(null) },
  };
}

/** Durable evidence within one route fixture; actual lineage validation still runs. */
export function authenticationFixtureDb() {
  const rows = new Map<string, AuthenticationEvidence>();
  const evidence = {
    create: vi.fn(async ({ data }: { data: Partial<AuthenticationEvidence> }) => {
      const row = { id: randomUUID(), parentId: null, revokedAt: null, consumedAt: null,
        connectionId: null, externalIdentityId: null, connectionRevision: null, connectionGeneration: null,
        policyGeneration: null, sessionDeadline: null, mfaCompletedAt: null, signatureCompletedAt: null,
        orgId: null, teamId: null, acr: null, createdAt: new Date(), ...data } as AuthenticationEvidence;
      rows.set(row.id, row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<AuthenticationEvidence> }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('Missing fixture authentication evidence');
      Object.assign(row, data);
      return row;
    }),
  };
  const db = {
    ...legacyCredentialStores(),
    authenticationEvidence: evidence,
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.com',
      tokenVersion: 0, lifecycleStatus: 'ACTIVE', twoFaEnabled: true }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => body(db),
  };
  return db;
}
