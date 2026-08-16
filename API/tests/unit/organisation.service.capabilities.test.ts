import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import { isBillingManager } from '../../src/services/billing-stripe-manager.service.js';
import {
  addOrganisationMember,
  removeOrganisationMember,
} from '../../src/services/organisation.service.members.js';
import {
  deactivateOrganisationMember,
  reactivateOrganisationMember,
} from '../../src/services/organisation.service.lifecycle.js';
import { updateOrganisation } from '../../src/services/organisation.service.organisation.js';
import {
  baseOrg,
  makeConfig,
  makePrismaMock,
  now,
  useOrganisationMembershipTestEnv,
} from './helpers/organisation-service-membership-test-helpers.js';

/**
 * The org-scope follow-up to wave 1 of
 * `Docs/plans/2026-08-16-configurable-roles-and-capabilities.md`.
 *
 * Wave 1 moved UOA's **team** gates onto `role_grants` and left three org-scope services still
 * comparing `role === 'owner' || role === 'admin'`. They now resolve capabilities too:
 * `members.manage` for the org roster (add / remove / deactivate / reactivate) and the new
 * `organisation.manage` for the organisation object (rename, invite policy, icon).
 *
 * The load-bearing assertion is the same one wave 1 made: with no `role_grants` — every domain
 * that exists today — each gate answers exactly what its hard-coded predicate answered, asserted
 * over every role rather than sampled.
 */

const ACTOR = 'u-actor';
const TARGET = 'u-target';

/** Same set the resolver's own equivalence test uses, including the near-misses. */
const ALL_ROLES = ['owner', 'admin', 'member', 'viewer', 'auditor', 'intern', '', 'Admin', 'OWNER'];

/** The predicate all three services shared before this change. */
function legacyIsOrgManager(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Seed the lookups every gate here makes: the org by id, the slug-collision probe, the ACTOR's org
 * membership at `actorRole`, and a plain `member` target. Keyed on the `where` clause rather than
 * call order, so a gate that short-circuits earlier or later still reads the same fixture.
 */
function seedOrg(prisma: PrismaClient, actorRole: string): void {
  prisma.organisation.findFirst.mockImplementation((args: { where: { id?: string } }) =>
    // `where.id` is the org lookup; anything else is `resolveUniqueSlugWithCollisionRetries`
    // probing whether a candidate slug is free.
    Promise.resolve(args.where.id ? { ...baseOrg, memberInvites: 'allowed', iconUrl: null } : null),
  );
  prisma.orgMember.findFirst.mockImplementation((args: { where: { userId?: string } }) => {
    if (args.where.userId === ACTOR) {
      return Promise.resolve({ id: 'om-actor', orgId: 'org-1', userId: ACTOR, role: actorRole });
    }
    if (args.where.userId === TARGET) {
      return Promise.resolve({ id: 'om-target', orgId: 'org-1', userId: TARGET, role: 'member' });
    }
    return Promise.resolve(null);
  });
  prisma.orgMember.count.mockResolvedValue(2);
  prisma.orgMember.update.mockResolvedValue({
    id: 'om-target',
    orgId: 'org-1',
    userId: TARGET,
    role: 'member',
    status: 'REMOVED',
    createdAt: now,
    updatedAt: now,
  });
  prisma.organisation.update.mockResolvedValue({
    ...baseOrg,
    name: 'Renamed',
    slug: 'renamed',
    memberInvites: 'allowed',
    iconUrl: null,
  });
  prisma.team.findFirst.mockResolvedValue({ id: 'team-default' });
  prisma.teamMember.updateMany.mockResolvedValue({ count: 1 });
  prisma.teamMember.create.mockResolvedValue({ id: 'tm-new' });
  prisma.groupMember.deleteMany.mockResolvedValue({ count: 0 });
  prisma.user.findUnique.mockResolvedValue({ id: 'u-new', domain: null });
  prisma.orgMember.create.mockResolvedValue({
    id: 'om-new',
    orgId: 'org-1',
    userId: 'u-new',
    role: 'member',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });
}

const orgParams = { orgId: 'org-1', domain: 'acme.example.com', actorUserId: ACTOR } as const;

/**
 * The five org-scope gates under test, each as "run it and let it throw". A gate's own downstream
 * invariants (owner counts, tombstones) are covered by the membership suites; what matters here is
 * only whether the actor got past the capability check.
 */
const GATES: {
  name: string;
  capability: 'members.manage' | 'organisation.manage';
  run: (prisma: PrismaClient, config: ClientConfig) => Promise<unknown>;
}[] = [
  {
    name: 'updateOrganisation (rename)',
    capability: 'organisation.manage',
    run: (prisma, config) =>
      updateOrganisation({ ...orgParams, name: 'Renamed', config }, { prisma }),
  },
  {
    name: 'addOrganisationMember',
    capability: 'members.manage',
    run: (prisma, config) =>
      addOrganisationMember(
        { ...orgParams, userId: 'u-new', role: 'member', config },
        { prisma },
      ),
  },
  {
    name: 'removeOrganisationMember',
    capability: 'members.manage',
    run: (prisma, config) =>
      removeOrganisationMember({ ...orgParams, userId: TARGET, config }, { prisma }),
  },
  {
    name: 'deactivateOrganisationMember',
    capability: 'members.manage',
    run: (prisma, config) =>
      deactivateOrganisationMember({ ...orgParams, userId: TARGET, config }, { prisma }),
  },
  {
    name: 'reactivateOrganisationMember',
    capability: 'members.manage',
    run: (prisma, config) =>
      reactivateOrganisationMember({ ...orgParams, userId: TARGET, config }, { prisma }),
  },
];

/**
 * Did the gate let the actor through?
 *
 * A 403 is the gate refusing. Anything else that throws is a *fixture* bug rather than an
 * authorization answer — a `BAD_REQUEST` from a role outside the configured vocabulary would
 * otherwise read as "allowed" and quietly hide a gate that never ran — so it is re-thrown.
 */
async function passedGate(
  gate: (typeof GATES)[number],
  actorRole: string,
  config: ClientConfig,
): Promise<boolean> {
  const prisma = makePrismaMock();
  seedOrg(prisma, actorRole);
  try {
    await gate.run(prisma, config);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'FORBIDDEN') return false;
    throw err;
  }
}

describe('Organisation service: org-scope gates, legacy-default equivalence', () => {
  useOrganisationMembershipTestEnv();

  for (const gate of GATES) {
    it(`${gate.name} (${gate.capability}) answers exactly owner|admin for every role`, async () => {
      for (const role of ALL_ROLES) {
        expect(await passedGate(gate, role, makeConfig()), `${gate.name}/${role}`).toBe(
          legacyIsOrgManager(role),
        );
      }
    });
  }

  it('still refuses an actor with no membership at all', async () => {
    for (const gate of GATES) {
      const prisma = makePrismaMock();
      seedOrg(prisma, 'owner');
      // Nobody matches the acting user — a deactivated or foreign actor looks like this.
      prisma.orgMember.findFirst.mockResolvedValue(null);

      await expect(gate.run(prisma, makeConfig())).rejects.toMatchObject({
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    }
  });
});

describe('Organisation service: org-scope gates under a domain-authored grant table', () => {
  useOrganisationMembershipTestEnv();

  /**
   * A domain that splits authority the default table fuses: `registrar` may rename the
   * organisation but never touch its roster, `steward` the reverse, and `intern` — in the
   * vocabulary but absent from the table — holds nothing. `member` stays in the vocabulary
   * because it is the role these gates *write*, and a write is validated against `org_roles`
   * before authorization is even reached.
   */
  const customConfig = makeConfig({
    org_roles: ['owner', 'member', 'registrar', 'steward', 'intern'],
    role_grants: {
      org: {
        registrar: ['organisation.manage'],
        steward: ['members.manage'],
      },
    },
  });

  const RENAME = GATES[0];
  const ROSTER_GATES = GATES.slice(1);

  it('lets a custom role granted organisation.manage rename the organisation', async () => {
    expect(await passedGate(RENAME, 'registrar', customConfig)).toBe(true);
  });

  it('does not let organisation.manage reach the roster', async () => {
    for (const gate of ROSTER_GATES) {
      expect(await passedGate(gate, 'registrar', customConfig), gate.name).toBe(false);
    }
  });

  it('does not make that role a billing manager — billing is a verdict, not a grant', async () => {
    // §4: `billing.manage` is computed by UOA from state only UOA holds (`BillingOrgResponsibility`
    // and the assignment scope), so it is deliberately NOT resolved from `role_grants`. Granting a
    // custom role every capability in the table must therefore leave billing exactly where it was.
    expect(isBillingManager({ scope: 'ORGANISATION', orgRole: 'registrar' })).toBe(false);
    expect(isBillingManager({ scope: 'ORGANISATION', orgRole: 'steward' })).toBe(false);
    expect(isBillingManager({ scope: 'ORGANISATION', orgRole: 'owner' })).toBe(true);
  });

  it('lets a custom role granted members.manage run the roster but not rename', async () => {
    for (const gate of ROSTER_GATES) {
      expect(await passedGate(gate, 'steward', customConfig), gate.name).toBe(true);
    }
    expect(await passedGate(RENAME, 'steward', customConfig)).toBe(false);
  });

  it('gives a role the table does not mention nothing at all', async () => {
    for (const gate of GATES) {
      expect(await passedGate(gate, 'intern', customConfig), gate.name).toBe(false);
    }
  });

  it('takes org authority away from `admin` when the table does not name it', async () => {
    // The configured table REPLACES the legacy default rather than adding to it, so `admin` — not
    // even in this domain's vocabulary — holds nothing.
    for (const gate of GATES) {
      expect(await passedGate(gate, 'admin', customConfig), gate.name).toBe(false);
    }
  });

  it('never locks the owner out, whatever the table says', async () => {
    const locked = makeConfig({
      org_roles: ['owner', 'member', 'registrar'],
      role_grants: { org: {}, team: {} },
    });

    for (const gate of GATES) {
      expect(await passedGate(gate, 'owner', locked), gate.name).toBe(true);
    }
  });
});
