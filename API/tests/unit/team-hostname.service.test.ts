import { describe, expect, it, vi } from 'vitest';

import {
  checkOrgSlugAvailability,
  checkTeamSlugAvailability,
  resolveOrgHostname,
  resolveTeamHostname,
} from '../../src/services/team-hostname.service.js';

function makePrisma() {
  return {
    organisation: { findFirst: vi.fn() },
    team: { findFirst: vi.fn() },
  };
}

describe('resolveTeamHostname', () => {
  it('walks left from the organisation, then finds the team inside it', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({ id: 'o1', name: 'Acme', slug: 'acme' });
    prisma.team.findFirst.mockResolvedValue({ id: 't1', name: 'Design', slug: 'design' });

    const resolved = await resolveTeamHostname(
      { domain: 'api.nessie.works', orgSlug: 'acme', teamSlug: 'design' },
      { prisma },
    );

    expect(resolved).toEqual({
      orgId: 'o1',
      orgName: 'Acme',
      orgSlug: 'acme',
      teamId: 't1',
      teamName: 'Design',
      teamSlug: 'design',
    });
    // The team lookup is scoped by the resolved org, never by slug alone — a
    // team slug is unique only within its organisation.
    expect(prisma.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'o1', slug: 'design' } }),
    );
  });

  it('scopes the organisation lookup to the calling client domain', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue(null);

    await resolveTeamHostname(
      { domain: 'api.nessie.works', orgSlug: 'acme', teamSlug: 'design' },
      { prisma },
    );

    expect(prisma.organisation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: 'api.nessie.works', slug: 'acme' } }),
    );
  });

  it('returns null for an unknown organisation without looking for a team', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue(null);

    expect(
      await resolveTeamHostname(
        { domain: 'api.nessie.works', orgSlug: 'nope', teamSlug: 'design' },
        { prisma },
      ),
    ).toBeNull();
    expect(prisma.team.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when the organisation exists but the team does not', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({ id: 'o1', name: 'Acme', slug: 'acme' });
    prisma.team.findFirst.mockResolvedValue(null);

    expect(
      await resolveTeamHostname(
        { domain: 'api.nessie.works', orgSlug: 'acme', teamSlug: 'nope' },
        { prisma },
      ),
    ).toBeNull();
  });

  it('accepts the labels case-insensitively, as hostnames are', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({ id: 'o1', name: 'Acme', slug: 'acme' });
    prisma.team.findFirst.mockResolvedValue({ id: 't1', name: 'Design', slug: 'design' });

    await resolveTeamHostname(
      { domain: 'api.nessie.works', orgSlug: 'ACME', teamSlug: 'Design' },
      { prisma },
    );

    expect(prisma.organisation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: 'api.nessie.works', slug: 'acme' } }),
    );
  });
});

describe('slug availability', () => {
  it('reports a free organisation label as available', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue(null);

    expect(
      await checkOrgSlugAvailability({ domain: 'api.nessie.works', slug: 'acme' }, { prisma }),
    ).toEqual({ available: true, slug: 'acme' });
  });

  it('reports a taken organisation label', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({ id: 'o1' });

    expect(
      await checkOrgSlugAvailability({ domain: 'api.nessie.works', slug: 'acme' }, { prisma }),
    ).toEqual({ available: false, reason: 'taken' });
  });

  it('reports why a label is invalid rather than just refusing it', async () => {
    const prisma = makePrisma();

    expect(
      await checkOrgSlugAvailability({ domain: 'api.nessie.works', slug: 'a' }, { prisma }),
    ).toEqual({ available: false, reason: 'too_short' });
    expect(
      await checkOrgSlugAvailability({ domain: 'api.nessie.works', slug: 'x--y' }, { prisma }),
    ).toEqual({ available: false, reason: 'double_hyphen' });
    expect(
      await checkOrgSlugAvailability({ domain: 'api.nessie.works', slug: '2026' }, { prisma }),
    ).toEqual({ available: false, reason: 'all_digits' });
    expect(
      await checkOrgSlugAvailability({ domain: 'api.nessie.works', slug: 'api' }, { prisma }),
    ).toEqual({ available: false, reason: 'reserved' });
    // An invalid label never reaches the database.
    expect(prisma.organisation.findFirst).not.toHaveBeenCalled();
  });

  it('honours product-declared reserved labels', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue(null);

    expect(
      await checkOrgSlugAvailability(
        { domain: 'api.nessie.works', slug: 'nessie', reservedLabels: ['nessie'] },
        { prisma },
      ),
    ).toEqual({ available: false, reason: 'reserved' });
  });

  it('scopes team availability to one organisation, not the whole domain', async () => {
    const prisma = makePrisma();
    prisma.team.findFirst.mockResolvedValue(null);

    expect(
      await checkTeamSlugAvailability({ orgId: 'o1', slug: 'design' }, { prisma }),
    ).toEqual({ available: true, slug: 'design' });
    // This scoping is what stops the check being an enumerator of other
    // customers' team names.
    expect(prisma.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'o1', slug: 'design' } }),
    );
  });

  it('reports a team label already used inside that organisation', async () => {
    const prisma = makePrisma();
    prisma.team.findFirst.mockResolvedValue({ id: 't1' });

    expect(
      await checkTeamSlugAvailability({ orgId: 'o1', slug: 'design' }, { prisma }),
    ).toEqual({ available: false, reason: 'taken' });
  });
});

describe('resolveOrgHostname', () => {
  it('resolves the tenant label alone, with the branding a landing page needs', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'o1',
      name: 'Acme',
      slug: 'acme',
      iconUrl: 'https://cdn.example.com/acme.png',
    });

    expect(
      await resolveOrgHostname({ domain: 'api.nessie.works', orgSlug: 'acme' }, { prisma }),
    ).toEqual({
      orgId: 'o1',
      orgName: 'Acme',
      orgSlug: 'acme',
      orgIconUrl: 'https://cdn.example.com/acme.png',
    });
  });

  it('returns a null icon rather than omitting it when none is set', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'o1',
      name: 'Acme',
      slug: 'acme',
      iconUrl: null,
    });

    const resolved = await resolveOrgHostname(
      { domain: 'api.nessie.works', orgSlug: 'acme' },
      { prisma },
    );
    expect(resolved?.orgIconUrl).toBeNull();
  });

  it('scopes the lookup to the calling client domain', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue(null);

    await resolveOrgHostname({ domain: 'api.nessie.works', orgSlug: 'acme' }, { prisma });

    expect(prisma.organisation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: 'api.nessie.works', slug: 'acme' } }),
    );
  });

  it('never touches the team table — a tenant landing page lists no teams', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'o1',
      name: 'Acme',
      slug: 'acme',
      iconUrl: null,
    });

    await resolveOrgHostname({ domain: 'api.nessie.works', orgSlug: 'acme' }, { prisma });

    // A guessable hostname must not become a directory of a customer's
    // internal structure. Teams are shown from the viewer's own membership,
    // after they authenticate, never from the hostname.
    expect(prisma.team.findFirst).not.toHaveBeenCalled();
  });

  it('returns null for an unknown label', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue(null);

    expect(
      await resolveOrgHostname({ domain: 'api.nessie.works', orgSlug: 'nope' }, { prisma }),
    ).toBeNull();
  });
});
