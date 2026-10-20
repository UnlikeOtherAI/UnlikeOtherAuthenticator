import { describe, expect, it, vi } from 'vitest';

import { AVATAR_MAX_BYTES } from '../../src/config/constants.js';
import {
  deleteTeamAvatar,
  requireDomainTeamId,
  requireTeamContext,
  resolveTeamAvatar,
  uploadTeamAvatar,
  type TeamAvatarDeps,
} from '../../src/services/team-avatar.service.js';
import { pickAvatarStyle } from '../../src/utils/avatar-svg.js';

/**
 * Team ("company") avatars mirror user avatars (Docs/Auth/avatars.md §11): uploaded → proxied
 * `iconUrl` → generated. These cover the team-shaped half; the source-agnostic half is exercised
 * by `avatar.service.test.ts` through the user path.
 */

type StoredTeam = {
  id: string;
  orgId: string;
  iconUrl: string | null;
  domain: string;
  updatedAt?: Date;
};
type StoredAvatar = {
  teamId: string;
  contentType: string;
  data: Uint8Array;
  sizeBytes: number;
  updatedAt: Date;
};

function png(byte = 0x01, length = 32): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(length, byte),
  ]);
}

function webp(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x2c, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.alloc(32, 0x11),
  ]);
}

type TeamWhere = { where: { id: string; org?: { domain: string } } };
type TeamIdWhere = { where: { teamId: string } };
type AvatarWrite = { contentType: string; data: Uint8Array; sizeBytes: number };
type UpsertArgs = TeamIdWhere & { create: AvatarWrite; update: AvatarWrite };
type TeamUpdateArgs = { where: { id: string }; data: { updatedAt: Date } };

/** In-memory stand-in for the two tables the team avatar service touches. */
function fakePrisma(
  seed: { teams?: StoredTeam[]; avatars?: StoredAvatar[] } = {},
): {
  avatars: Map<string, StoredAvatar>;
  teams: Map<string, StoredTeam>;
  prisma: NonNullable<TeamAvatarDeps['prisma']>;
} {
  const teams = new Map((seed.teams ?? []).map((team) => [team.id, team]));
  const avatars = new Map((seed.avatars ?? []).map((row) => [row.teamId, row]));

  const store = {
    team: {
      findFirst: async (args: TeamWhere) => {
        const team = teams.get(args.where.id);
        if (!team) return null;
        // The `/domain/*` route narrows by the owning organisation's domain.
        if (args.where.org && args.where.org.domain !== team.domain) return null;
        return {
          id: team.id,
          orgId: team.orgId,
          iconUrl: team.iconUrl,
          org: { domain: team.domain },
        };
      },
      update: async (args: TeamUpdateArgs) => {
        const team = teams.get(args.where.id);
        if (!team) throw new Error('team not found');
        team.updatedAt = args.data.updatedAt;
        return { id: team.id };
      },
    },
    teamAvatar: {
      findUnique: async (args: TeamIdWhere) => avatars.get(args.where.teamId) ?? null,
      upsert: async (args: UpsertArgs) => {
        const existing = avatars.get(args.where.teamId);
        const source = existing ? args.update : args.create;
        const next: StoredAvatar = {
          teamId: args.where.teamId,
          contentType: source.contentType,
          data: source.data,
          sizeBytes: source.sizeBytes,
          updatedAt: new Date('2026-07-25T10:00:00.000Z'),
        };
        avatars.set(next.teamId, next);
        return next;
      },
      deleteMany: async (args: TeamIdWhere) => ({
        count: avatars.delete(args.where.teamId) ? 1 : 0,
      }),
    },
  };

  return { avatars, teams, prisma: store as unknown as NonNullable<TeamAvatarDeps['prisma']> };
}

const TEAM: StoredTeam = {
  id: 'team_1',
  orgId: 'org_1',
  iconUrl: null,
  domain: 'client.example.com',
};
const TEAM_EDITED_AT = new Date('2026-07-01T00:00:00.000Z');

describe('team avatar resolution precedence', () => {
  it('prefers the uploaded image over the team icon URL', async () => {
    const { prisma } = fakePrisma({
      teams: [{ ...TEAM, iconUrl: 'https://cdn.example.com/logo.png' }],
      avatars: [
        {
          teamId: 'team_1',
          contentType: 'image/webp',
          data: webp(),
          sizeBytes: 44,
          updatedAt: new Date(),
        },
      ],
    });
    const fetchProvider = vi.fn(async () => ({ contentType: 'image/png' as const, body: png() }));

    const avatar = await resolveTeamAvatar({ teamId: 'team_1' }, { prisma, fetchProvider });

    expect(avatar.source).toBe('uploaded');
    expect(avatar.contentType).toBe('image/webp');
    expect(avatar.filename).toBe('avatar.webp');
    expect(avatar.cacheControl).toBe('private, max-age=300');
    expect(avatar.isSvg).toBe(false);
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it('proxies the team icon URL when there is no upload', async () => {
    const { prisma } = fakePrisma({
      teams: [{ ...TEAM, iconUrl: 'https://cdn.example.com/logo.png' }],
    });
    const body = png(0x22);
    const fetchProvider = vi.fn(async () => ({ contentType: 'image/png' as const, body }));

    const avatar = await resolveTeamAvatar({ teamId: 'team_1' }, { prisma, fetchProvider });

    expect(fetchProvider).toHaveBeenCalledWith('https://cdn.example.com/logo.png');
    expect(avatar.source).toBe('provider');
    expect(avatar.contentType).toBe('image/png');
    expect(avatar.body.equals(body)).toBe(true);
    expect(avatar.cacheControl).toBe('private, max-age=300');
  });

  it('falls back to the generated image when the icon URL fetch fails', async () => {
    const { prisma } = fakePrisma({
      teams: [{ ...TEAM, iconUrl: 'https://cdn.example.com/dead.png' }],
    });
    const fetchProvider = vi.fn(async () => null);

    const avatar = await resolveTeamAvatar({ teamId: 'team_1' }, { prisma, fetchProvider });

    expect(fetchProvider).toHaveBeenCalledOnce();
    expect(avatar.source).toBe('generated');
    expect(avatar.contentType).toBe('image/svg+xml; charset=utf-8');
    expect(avatar.cacheControl).toBe('private, max-age=86400');
    expect(avatar.isSvg).toBe(true);
    expect(avatar.filename).toBe('avatar.svg');
    expect(avatar.body.toString('utf8')).toContain('<svg');
  });

  it('generates without any network call when the team has no icon URL', async () => {
    const { prisma } = fakePrisma({ teams: [TEAM] });
    const fetchProvider = vi.fn(async () => null);

    const avatar = await resolveTeamAvatar({ teamId: 'team_1' }, { prisma, fetchProvider });

    expect(fetchProvider).not.toHaveBeenCalled();
    expect(avatar.source).toBe('generated');
  });

  it('seeds the generated image from the team id, and applies the style selection order', async () => {
    const { prisma } = fakePrisma({
      teams: [TEAM, { ...TEAM, id: 'team_2' }],
    });

    const overridden = await resolveTeamAvatar(
      { teamId: 'team_1', style: 'waves', configDefaultStyle: 'mono' },
      { prisma },
    );
    const configured = await resolveTeamAvatar(
      { teamId: 'team_1', configDefaultStyle: 'mono' },
      { prisma },
    );
    const fallback = await resolveTeamAvatar({ teamId: 'team_1' }, { prisma });
    const pinnedToTeamPick = await resolveTeamAvatar(
      { teamId: 'team_1', style: pickAvatarStyle('team_1') },
      { prisma },
    );
    const otherTeam = await resolveTeamAvatar({ teamId: 'team_2' }, { prisma });

    // `mono` is the only style with no hsl colours, which makes the selections distinguishable.
    expect(overridden.body.toString('utf8')).toMatch(/hsl\(/);
    expect(configured.body.toString('utf8')).not.toMatch(/hsl\(/);
    expect(fallback.body.toString('utf8')).toBe(pinnedToTeamPick.body.toString('utf8'));
    expect(otherTeam.body.toString('utf8')).not.toBe(fallback.body.toString('utf8'));
  });

  it('honours ?size= and keeps the ETag stable for identical bytes', async () => {
    const { prisma } = fakePrisma({ teams: [TEAM] });

    const a = await resolveTeamAvatar({ teamId: 'team_1', style: 'rings', size: 128 }, { prisma });
    const b = await resolveTeamAvatar({ teamId: 'team_1', style: 'rings', size: 128 }, { prisma });
    const c = await resolveTeamAvatar({ teamId: 'team_1', style: 'rings', size: 64 }, { prisma });

    expect(a.etag).toBe(b.etag);
    expect(a.etag).not.toBe(c.etag);
    expect(a.etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
    expect(c.body.toString('utf8')).toContain('width="64" height="64"');
  });

  it('is a generic 404 for an unknown team', async () => {
    const { prisma } = fakePrisma();
    await expect(resolveTeamAvatar({ teamId: 'nope' }, { prisma })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('team avatar upload validation', () => {
  it('stores the sniffed type, not the caller-supplied one', async () => {
    const { prisma, avatars } = fakePrisma({ teams: [TEAM] });

    const result = await uploadTeamAvatar({ teamId: 'team_1', data: webp() }, { prisma });

    expect(result.source).toBe('uploaded');
    expect(result.contentType).toBe('image/webp');
    expect(result.sizeBytes).toBe(webp().byteLength);
    expect(avatars.get('team_1')?.contentType).toBe('image/webp');
  });

  it('rejects SVG, HTML and PDF uploads with a generic error', async () => {
    const { prisma } = fakePrisma({ teams: [TEAM] });

    for (const payload of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<!doctype html><script>alert(1)</script>',
      '%PDF-1.7\n',
    ]) {
      await expect(
        uploadTeamAvatar({ teamId: 'team_1', data: Buffer.from(payload, 'binary') }, { prisma }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('rejects an empty upload and anything over the 1 MiB cap', async () => {
    const { prisma } = fakePrisma({ teams: [TEAM] });

    await expect(
      uploadTeamAvatar({ teamId: 'team_1', data: Buffer.alloc(0) }, { prisma }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      uploadTeamAvatar({ teamId: 'team_1', data: png(0x02, AVATAR_MAX_BYTES + 1) }, { prisma }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it('replaces an existing upload rather than adding a second row', async () => {
    const { prisma, avatars } = fakePrisma({ teams: [TEAM] });

    await uploadTeamAvatar({ teamId: 'team_1', data: png() }, { prisma });
    await uploadTeamAvatar({ teamId: 'team_1', data: webp() }, { prisma });

    expect(avatars.size).toBe(1);
    expect(avatars.get('team_1')?.contentType).toBe('image/webp');
  });

  it('is a generic 404 for an unknown team', async () => {
    const { prisma } = fakePrisma();
    await expect(
      uploadTeamAvatar({ teamId: 'nope', data: png() }, { prisma }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('moves the team row to the upload time, which versions the public URL (§11.4)', async () => {
    const { prisma, teams } = fakePrisma({ teams: [{ ...TEAM, updatedAt: TEAM_EDITED_AT }] });

    const result = await uploadTeamAvatar({ teamId: 'team_1', data: png() }, { prisma });

    expect(teams.get('team_1')?.updatedAt).toEqual(result.updatedAt);
    expect(result.updatedAt).not.toEqual(TEAM_EDITED_AT);
  });
});

describe('team avatar delete', () => {
  it('deletes idempotently and falls back to the icon URL afterwards', async () => {
    const { prisma, avatars } = fakePrisma({
      teams: [{ ...TEAM, iconUrl: 'https://cdn.example.com/logo.png' }],
      avatars: [
        {
          teamId: 'team_1',
          contentType: 'image/png',
          data: png(),
          sizeBytes: 40,
          updatedAt: new Date(),
        },
      ],
    });
    const fetchProvider = vi.fn(async () => ({ contentType: 'image/png' as const, body: png() }));

    await deleteTeamAvatar({ teamId: 'team_1' }, { prisma });
    await deleteTeamAvatar({ teamId: 'team_1' }, { prisma });

    expect(avatars.size).toBe(0);
    expect((await resolveTeamAvatar({ teamId: 'team_1' }, { prisma, fetchProvider })).source).toBe(
      'provider',
    );
  });

  it('moves the team row only when it removed an upload (§11.4)', async () => {
    const { prisma, teams } = fakePrisma({
      teams: [{ ...TEAM, updatedAt: TEAM_EDITED_AT }],
      avatars: [
        { teamId: 'team_1', contentType: 'image/png', data: png(), sizeBytes: 40, updatedAt: TEAM_EDITED_AT },
      ],
    });

    await deleteTeamAvatar({ teamId: 'team_1' }, { prisma });
    const removedAt = teams.get('team_1')?.updatedAt;
    await deleteTeamAvatar({ teamId: 'team_1' }, { prisma });

    expect(removedAt?.getTime()).toBeGreaterThan(TEAM_EDITED_AT.getTime());
    expect(teams.get('team_1')?.updatedAt).toBe(removedAt);
  });
});

describe('team domain visibility', () => {
  it('accepts a team whose organisation belongs to the authenticated domain', async () => {
    const { prisma } = fakePrisma({ teams: [TEAM] });

    await expect(
      requireDomainTeamId({ domain: 'CLIENT.example.com ', teamId: 'team_1' }, { prisma }),
    ).resolves.toBe('team_1');
  });

  it('is a generic 404 for a cross-domain or unknown team id', async () => {
    const { prisma } = fakePrisma({
      teams: [{ ...TEAM, domain: 'other.example.com' }],
    });

    await expect(
      requireDomainTeamId({ domain: 'client.example.com', teamId: 'team_1' }, { prisma }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      requireDomainTeamId({ domain: 'client.example.com', teamId: 'ghost' }, { prisma }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('resolves the org and owning domain for the admin routes, 404 otherwise', async () => {
    const { prisma } = fakePrisma({ teams: [TEAM] });

    await expect(requireTeamContext('team_1', { prisma })).resolves.toEqual({
      teamId: 'team_1',
      orgId: 'org_1',
      domain: 'client.example.com',
    });
    await expect(requireTeamContext('ghost', { prisma })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
