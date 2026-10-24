import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { placeUserInConfiguredOrganisation } from '../../src/services/org-placement.service.js';
import { ensureUserHasRequiredTeam } from '../../src/services/user-team-requirement.service.js';
import { makeConfig } from './helpers/org-placement-config.js';

function fixture() {
  const occupied = new Set<string>();
  const attempts: string[] = [];
  const user = { id: 'person', name: 'Alice', email: 'alice@example.test' };
  const tx = {
    $queryRaw: vi.fn(async (query: { sql: string; values: unknown[] }) =>
      query.sql.includes('uoa_organisation_slug_taken')
        ? [{ taken: occupied.has(String(query.values[0])) }] : [{ id: user.id }]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    user: { findUnique: vi.fn().mockResolvedValue(user) },
    organisation: {
      create: vi.fn(async ({ data }: { data: { slug: string } }) => {
        attempts.push(data.slug);
        if (attempts.length === 1) {
          occupied.add(data.slug);
          throw new Prisma.PrismaClientKnownRequestError('another domain just claimed the label', {
            code: 'P2002', clientVersion: 'test',
            meta: { modelName: 'Organisation', target: 'organisations_slug_admission_key' },
          });
        }
        return { id: 'new-org' };
      }),
    },
    orgMember: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'owner' }) },
    team: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'new-team' }) },
    teamMember: { create: vi.fn().mockResolvedValue({ id: 'team-member' }) },
  };
  const prisma = {
    user: tx.user,
    teamInvite: { findFirst: vi.fn().mockResolvedValue(null) },
    orgMember: tx.orgMember,
    $transaction: vi.fn(async (operation: (inner: typeof tx) => Promise<unknown>) => operation(tx)),
  } as unknown as PrismaClient;
  return { tx, prisma, attempts };
}

describe('automatic address allocation at its real callers', () => {
  it.each(['first-login placement', 'required-team placement'] as const)('%s retries a foreign-domain race', async caller => {
    const { tx, prisma, attempts } = fixture();
    const config = makeConfig();
    config.org_features.auto_create_personal_org_on_first_login = true;
    config.org_features.user_needs_team = true;
    if (caller === 'first-login placement') {
      const logError = vi.fn();
      expect(await placeUserInConfiguredOrganisation({ userId: 'person', email: 'alice@example.test', config },
        { prisma, logError })).toEqual({ status: 'auto_created', orgId: 'new-org', teamId: 'new-team' });
      expect(logError).not.toHaveBeenCalled();
    } else {
      expect(await ensureUserHasRequiredTeam({ userId: 'person', config },
        { prisma, env: { DATABASE_URL: 'postgres://example' } as never }))
        .toEqual({ orgId: 'new-org', teamId: 'new-team' });
    }
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatch(new RegExp(`^${attempts[0]}-[a-z0-9]+$`));
    expect(tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql)).toEqual([
      'SAVEPOINT uoa_automatic_org_slug', 'ROLLBACK TO SAVEPOINT uoa_automatic_org_slug',
      'RELEASE SAVEPOINT uoa_automatic_org_slug', 'SAVEPOINT uoa_automatic_org_slug',
      'RELEASE SAVEPOINT uoa_automatic_org_slug',
    ]);
    expect(tx.team.create).toHaveBeenCalledTimes(1);
    expect(tx.orgMember.create).toHaveBeenCalledTimes(1);
    expect(tx.teamMember.create).toHaveBeenCalledTimes(1);
  });

  it('required-team placement preserves an unrelated failure without retrying it', async () => {
    const { tx, prisma } = fixture();
    const error = new Error('storage unavailable');
    tx.organisation.create.mockRejectedValue(error);
    const config = makeConfig();
    config.org_features.user_needs_team = true;
    await expect(ensureUserHasRequiredTeam({ userId: 'person', config },
      { prisma, env: { DATABASE_URL: 'postgres://example' } as never })).rejects.toBe(error);
    expect(tx.organisation.create).toHaveBeenCalledTimes(1);
    expect(tx.teamMember.create).not.toHaveBeenCalled();
  });

  it('optional first-login placement keeps its documented failure outcome without retrying unrelated errors', async () => {
    const { tx, prisma } = fixture();
    const logError = vi.fn();
    tx.organisation.create.mockRejectedValue(new Error('storage unavailable'));
    const config = makeConfig();
    config.org_features.auto_create_personal_org_on_first_login = true;
    expect(await placeUserInConfiguredOrganisation({ userId: 'person', email: 'alice@example.test', config },
      { prisma, logError })).toEqual({ status: 'skipped', reason: 'auto_create_failed' });
    expect(tx.organisation.create).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(tx.teamMember.create).not.toHaveBeenCalled();
  });
});
