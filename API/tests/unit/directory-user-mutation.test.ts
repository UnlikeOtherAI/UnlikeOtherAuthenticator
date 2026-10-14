import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withDirectoryUserMutation } from '../../src/services/directory-user-mutation.service.js';
import {
  withDirectoryMutation,
  directoryNewOrganisationId,
} from '../../src/services/directory-mutation.service.js';
function fixture() {
  const raw = {
    $queryRaw: vi.fn(async () => []),
    orgMember: { findMany: vi.fn(async () => [{ orgId: 'org-b' }, { orgId: 'org-a' }]) },
    organisation: { findMany: vi.fn(async () => [{ id: 'org-owner' }]) },
  };
  return { raw, db: raw as unknown as PrismaClient };
}
describe('composed user directory mutations', () => {
  it('takes the canonical user lock then the sorted complete org set before writing', async () => {
    const f = fixture();
    await withDirectoryUserMutation(f.db, 'person', 'profile.changed', async () => {
      const sql = f.raw.$queryRaw.mock.calls.map(
        (call) => (call[0] as { values: unknown[] }).values,
      );
      expect(sql[0]).toEqual([JSON.stringify(['uoa:refresh-session:user:v1', 'person'])]);
      expect(sql.slice(1)).toEqual([
        ['uoa:directory-org:v1:org-a'],
        ['uoa:directory-org:v1:org-b'],
        ['uoa:directory-org:v1:org-owner'],
      ]);
    });
    const emitted = f.raw.$queryRaw.mock.calls
      .slice(4)
      .map((call) => (call[0] as { values: unknown[] }).values);
    expect(emitted.map((values) => values.slice(1))).toEqual([
      ['org-a', 'profile.changed', 'person', null],
      ['org-b', 'profile.changed', 'person', null],
      ['org-owner', 'profile.changed', 'person', null],
    ]);
  });
  it('declares a verified invite and a potential new-org ID before a composed profile write', async () => {
    const f = fixture();
    let createdId = '';
    await withDirectoryUserMutation(
      f.db,
      'person',
      'profile.changed',
      async (tx) => {
        createdId = directoryNewOrganisationId(tx);
        await withDirectoryMutation(
          tx,
          [{ orgId: 'invite-org', kind: 'membership.changed' }],
          async () => undefined,
        );
        await withDirectoryMutation(
          tx,
          [{ orgId: createdId, kind: 'organisation.changed' }],
          async () => undefined,
        );
      },
      { additionalOrgIds: ['invite-org'], mayCreateOrganisation: true },
    );
    expect(createdId).toBeTruthy();
    expect(directoryNewOrganisationId(f.db)).toBe(createdId);
  });
  it('refuses an undeclared later org before executing its write', async () => {
    const f = fixture();
    const write = vi.fn();
    await expect(
      withDirectoryUserMutation(f.db, 'person', 'profile.changed', async (tx) => {
        await withDirectoryMutation(
          tx,
          [{ orgId: 'undeclared', kind: 'membership.changed' }],
          write,
        );
      }),
    ).rejects.toThrow('resolve all organisations');
    expect(write).not.toHaveBeenCalled();
  });
});
