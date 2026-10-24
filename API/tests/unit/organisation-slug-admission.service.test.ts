import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  isOrganisationSlugConflict,
  isOrganisationSlugTaken,
  withAutomaticOrganisationSlug,
  withChosenOrganisationSlug,
} from '../../src/services/organisation-slug-admission.service.js';
import { ensureAvailableOrgSlug, deriveSlugWithValidation } from '../../src/services/organisation.service.base.js';

function conflict(meta: Record<string, unknown>, code = 'P2002') {
  return new Prisma.PrismaClientKnownRequestError('constraint rejected the write', {
    code, clientVersion: 'test', meta,
  });
}

const slugConflict = () => conflict({ modelName: 'Organisation', target: 'organisations_slug_admission_key' });

describe('global organisation address admission', () => {
  it.each([true, false])('reads only parameterized global occupancy: %s', async taken => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ taken }]) };
    expect(await isOrganisationSlugTaken(prisma, 'customer-name')).toBe(taken);
    const [query] = prisma.$queryRaw.mock.calls[0];
    expect(query.values).toEqual(['customer-name']);
    expect(query.sql).toContain('uoa_organisation_slug_taken(?)');
    expect(query.sql).not.toContain('customer-name');
  });

  it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ taken: null }] }, { rows: [{ taken: 'false' }] }])(
    'refuses a malformed occupancy result: %j', async ({ rows }) => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue(rows) };
    await expect(isOrganisationSlugTaken(prisma, 'acme')).rejects.toMatchObject({ statusCode: 500 });
    },
  );

  it('preserves an unchanged legacy address without probing global occupancy', async () => {
    const prisma = { $queryRaw: vi.fn() };
    expect(await ensureAvailableOrgSlug({ domain: 'other.example', prisma, slug: 'acme', existingSlugToIgnore: 'acme' }))
      .toBe('acme');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('suffixes an automatically derived label that another domain already occupies', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValueOnce([{ taken: true }]).mockResolvedValue([{ taken: false }]) };
    const slug = await deriveSlugWithValidation('another.example', prisma, 'Acme');
    expect(slug).toMatch(/^acme-[a-z0-9]+$/);
    expect(prisma.$queryRaw.mock.calls.map(([query]) => query.values)).toEqual([['acme'], [slug]]);
  });

  it.each([
    { modelName: 'Organisation', target: ['domain', 'slug'] },
    { modelName: 'Organisation', target: 'organisations_slug_admission_key' },
  ])('maps a chosen-address race to its existing public refusal: %j', async meta => {
    await expect(withChosenOrganisationSlug(async () => { throw conflict(meta); }))
      .rejects.toMatchObject({ statusCode: 400, message: 'ORG_SLUG_TAKEN' });
  });

  it.each([
    new Error('database disconnected'),
    conflict({ modelName: 'Team', target: ['slug'] }),
    conflict({ modelName: 'Organisation', target: ['owner_id'] }),
    conflict({ modelName: 'Organisation', target: ['slug'] }, 'P2003'),
    { code: 'P2002', meta: { modelName: 'Organisation', target: ['slug'] } },
  ])('keeps an unrelated error intact instead of disguising it as an address conflict: %j', async error => {
    expect(isOrganisationSlugConflict(error)).toBe(false);
    await expect(withChosenOrganisationSlug(async () => { throw error; })).rejects.toBe(error);
  });

  it('rolls back a raced automatic allocation before retrying and releases the successful savepoint', async () => {
    const events: string[] = [];
    const tx = { $executeRawUnsafe: vi.fn(async (sql: string) => { events.push(sql); return 0; }) };
    let attempts = 0;
    const result = await withAutomaticOrganisationSlug(tx, async () => {
      events.push(`allocate-${++attempts}`);
      if (attempts === 1) throw slugConflict();
      return { orgId: 'org-new', teamId: 'team-new' };
    });
    expect(result).toEqual({ orgId: 'org-new', teamId: 'team-new' });
    expect(events).toEqual([
      'SAVEPOINT uoa_automatic_org_slug', 'allocate-1',
      'ROLLBACK TO SAVEPOINT uoa_automatic_org_slug', 'RELEASE SAVEPOINT uoa_automatic_org_slug',
      'SAVEPOINT uoa_automatic_org_slug', 'allocate-2', 'RELEASE SAVEPOINT uoa_automatic_org_slug',
    ]);
  });

  it.each([
    new Error('database disconnected'),
    conflict({ modelName: 'Team', target: ['slug'] }),
    conflict({ modelName: 'Organisation', target: ['owner_id'] }),
  ])('rolls back an unrelated automatic-allocation failure without retrying it: %j', async error => {
    const tx = { $executeRawUnsafe: vi.fn().mockResolvedValue(0) };
    const operation = vi.fn().mockRejectedValue(error);
    await expect(withAutomaticOrganisationSlug(tx, operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql)).toEqual([
      'SAVEPOINT uoa_automatic_org_slug', 'ROLLBACK TO SAVEPOINT uoa_automatic_org_slug',
      'RELEASE SAVEPOINT uoa_automatic_org_slug',
    ]);
  });

  it('bounds repeated races and leaves the transaction outside every failed savepoint', async () => {
    const tx = { $executeRawUnsafe: vi.fn().mockResolvedValue(0) };
    const operation = vi.fn().mockRejectedValue(slugConflict());
    await expect(withAutomaticOrganisationSlug(tx, operation))
      .rejects.toMatchObject({ statusCode: 500, message: 'ORG_SLUG_COLLISION_RETRY_EXHAUSTED' });
    expect(operation).toHaveBeenCalledTimes(10);
    expect(tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql)).toEqual(Array.from({ length: 10 }, () => [
      'SAVEPOINT uoa_automatic_org_slug', 'ROLLBACK TO SAVEPOINT uoa_automatic_org_slug',
      'RELEASE SAVEPOINT uoa_automatic_org_slug',
    ]).flat());
  });
});
