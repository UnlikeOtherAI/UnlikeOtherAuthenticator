import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { getOrganisationMember } from '../../src/services/organisation.service.base.js';

// CLAUDE.md 500-line split of the original organisation.service.membership.test.ts: the
// activeOnly actor-authorization filter (§4.9). See organisation.service.membership.test.ts
// (add/list/role-change/remove/ownership-transfer) and
// organisation.service.membership.lifecycle.test.ts (deactivate/reactivate) for the rest. Only the
// location changed — no assertion here was altered from the pre-split file. This describe never
// used the shared mocks/env helpers in the pre-split file either, so it stays dependency-free here.
describe('getOrganisationMember: activeOnly actor-authorization filter (§4.9)', () => {
  it('adds status:ACTIVE to the where clause when activeOnly is set (deactivated actor has no powers)', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { orgMember: { findFirst } } as unknown as PrismaClient;

    await getOrganisationMember(prisma, { orgId: 'org-1', userId: 'actor-1' }, { activeOnly: true });

    expect(findFirst).toHaveBeenCalledWith({
      where: { orgId: 'org-1', userId: 'actor-1', status: 'ACTIVE' },
      select: { id: true, orgId: true, userId: true, role: true },
    });
  });

  it('omits the status filter by default so target lookups still find DEACTIVATED/REMOVED rows', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { orgMember: { findFirst } } as unknown as PrismaClient;

    await getOrganisationMember(prisma, { orgId: 'org-1', userId: 'target-1' });

    expect(findFirst).toHaveBeenCalledWith({
      where: { orgId: 'org-1', userId: 'target-1' },
      select: { id: true, orgId: true, userId: true, role: true },
    });
  });
});
