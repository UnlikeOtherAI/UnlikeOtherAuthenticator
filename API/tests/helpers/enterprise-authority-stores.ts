import { vi } from 'vitest';

/** Explicit empty enterprise stores for service fixtures whose subject has no SSO evidence.
 * Real scope propagation, rollback and consumer enumeration are covered with PostgreSQL. */
export function enterpriseAuthorityStores() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(0),
    domainRole: { findMany: vi.fn().mockResolvedValue([]) },
    orgMember: { findMany: vi.fn().mockResolvedValue([]) },
    organisation: { findUniqueOrThrow: vi.fn().mockResolvedValue({ domain: 'client.example.com' }) },
    team: { findUniqueOrThrow: vi.fn().mockResolvedValue({ orgId: 'org-1', org: { domain: 'client.example.com' } }) },
    sessionAssurance: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    orgRevocationEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
  };
}
