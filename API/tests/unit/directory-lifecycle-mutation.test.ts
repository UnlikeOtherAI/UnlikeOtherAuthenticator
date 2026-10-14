import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withDirectoryLifecycleMutation } from '../../src/services/directory-lifecycle-mutation.service.js';
function fixture() {
  const raw = {
    $queryRaw: vi.fn(async (sql: { strings: string[] }) =>
      sql.strings.join('').includes('SELECT DISTINCT org_id')
        ? [{ orgId: 'old-live' }, { orgId: 'retired' }]
        : [],
    ),
    user: { findUnique: vi.fn(async () => ({ email: null as string | null })) },
    orgMember: {
      findMany: vi.fn(async (input: { where: { userId?: string } }) =>
        input.where.userId ? [{ orgId: 'current' }] : [{ userId: 'z' }],
      ),
    },
    organisation: {
      findMany: vi.fn(async (input: { where: { id?: { in: string[] } } }) =>
        input.where.id
          ? input.where.id.in.filter((id) => id !== 'retired').map((id) => ({ id }))
          : [],
      ),
    },
    historicalOrganisationIdentityReference: {
      findMany: vi.fn(async () => [{ orgId: 'history' }, { orgId: 'retired' }]),
    },
    team: { findUnique: vi.fn(async () => ({ orgId: 'team-org' })) },
    teamMember: { findMany: vi.fn(async () => [{ userId: 'a' }]) },
  };
  return { raw, db: raw as unknown as PrismaClient };
}
function values(f: ReturnType<typeof fixture>) {
  return f.raw.$queryRaw.mock.calls.map(
    (call) => (call[0] as unknown as { values: unknown[] }).values,
  );
}
describe('directory lifecycle planning', () => {
  it('locks historical/previous outbox scopes before erasure but emits no erased subject or retired-org event', async () => {
    const f = fixture();
    await withDirectoryLifecycleMutation(
      f.db,
      { scope: 'USER', id: 'person', deleted: true, eraseReference: true },
      async () => {
        const keys = values(f)
          .map((row) => row[0])
          .filter((value) => String(value).startsWith('uoa:directory-org:v1:'));
        expect(keys).toEqual(
          ['current', 'history', 'old-live', 'retired'].map((id) => 'uoa:directory-org:v1:' + id),
        );
        expect(values(f).some((row) => row[2] === 'membership.changed')).toBe(false);
      },
    );
    const events = values(f).filter((row) => row[2] === 'membership.changed');
    expect(events.map((row) => row.slice(1))).toEqual([
      ['current', 'membership.changed', null, null],
      ['history', 'membership.changed', null, null],
      ['old-live', 'membership.changed', null, null],
    ]);
  });
  it('invalidates exact live orgs without disclosing deleted subject IDs', async () => {
    const f = fixture();
    await withDirectoryLifecycleMutation(
      f.db,
      { scope: 'USER', id: 'person', deleted: true },
      async () => undefined,
    );
    const events = values(f).filter((row) => row[2] === 'membership.changed');
    expect(events.map((row) => row.slice(1))).toEqual([
      ['current', 'membership.changed', null, null],
      ['history', 'membership.changed', null, null],
    ]);
  });
  it('invalidates an allowlist-only org without disclosing the erased subject', async () => {
    const f = fixture();
    f.raw.user.findUnique.mockResolvedValue({ email: 'private@example.com' });
    f.raw.$queryRaw.mockImplementation(async (sql: { strings: string[] }) =>
      sql.strings.join('').includes('unnest(allowed_emails)') ? [{ orgId: 'policy-only' }] : [],
    );
    await withDirectoryLifecycleMutation(
      f.db,
      { scope: 'USER', id: 'person', deleted: true },
      async () => undefined,
    );
    const event = values(f).find(
      (row) => row[1] === 'policy-only' && row[2] === 'membership.changed',
    );
    expect(event?.slice(1)).toEqual(['policy-only', 'membership.changed', null, null]);
    expect(
      JSON.stringify(values(f).filter((row) => row[2] === 'membership.changed')),
    ).not.toContain('private@example.com');
  });

  it('pins the complete org member set in sorted user order before terminal org mutation', async () => {
    const f = fixture();
    await withDirectoryLifecycleMutation(
      f.db,
      { scope: 'ORGANISATION', id: 'org', deleted: true, pinAllMembers: true },
      async () => {
        const users = values(f)
          .map((row) => row[0])
          .filter((value) => String(value).startsWith('["uoa:refresh-session:user:v1"'));
        expect(users).toEqual(
          ['a', 'z'].map((id) => JSON.stringify(['uoa:refresh-session:user:v1', id])),
        );
      },
    );
    expect(
      values(f)
        .filter((row) => row[2] === 'organisation.deleted')
        .map((row) => row.slice(1)),
    ).toEqual([['org', 'organisation.deleted', null, null]]);
  });
});
