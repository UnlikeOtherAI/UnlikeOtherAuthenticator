import { unboundDirectoryUserStore } from '../helpers/directory-store.js';
import { describe, expect, it, vi } from 'vitest';

import {
  deleteAvatar,
  getAvatarSources,
  requireDomainUserId,
  requireUserContext,
  resolveAvatar,
  uploadAvatar,
  type AvatarDeps,
} from '../../src/services/avatar.service.js';
import { AVATAR_MAX_BYTES } from '../../src/config/constants.js';
import { pickAvatarStyle } from '../../src/utils/avatar-svg.js';

type StoredUser = {
  id: string;
  avatarUrl: string | null;
  email?: string;
  domain?: string | null;
};
type StoredAvatar = {
  userId: string;
  contentType: string;
  data: Uint8Array;
  sizeBytes: number;
  updatedAt: Date;
};

function png(byte = 0x01, length = 32): Buffer {
  const body = Buffer.alloc(length, byte);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body]);
}

function jpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x7f)]);
}

/**
 * In-memory stand-in for the two tables the avatar service touches. Deliberately narrow: it only
 * implements the queries the service actually issues.
 */
type IdWhere = { where: { id: string } };
type IdInWhere = { where: { id: { in: string[] } } };
type UserIdWhere = { where: { userId: string } };
type UserIdInWhere = { where: { userId: { in: string[] } } };
type AvatarWrite = { contentType: string; data: Uint8Array; sizeBytes: number };
type UpsertArgs = UserIdWhere & { create: AvatarWrite; update: AvatarWrite };
type DomainRoleWhere = { where: { domain_userId: { domain: string; userId: string } } };

function fakePrisma(
  seed: {
    users?: StoredUser[];
    avatars?: StoredAvatar[];
    roles?: Array<{ domain: string; userId: string }>;
  } = {},
): { avatars: Map<string, StoredAvatar>; prisma: NonNullable<AvatarDeps['prisma']> } {
  const users = new Map((seed.users ?? []).map((user) => [user.id, user]));
  const avatars = new Map((seed.avatars ?? []).map((row) => [row.userId, row]));
  const roles = new Set((seed.roles ?? []).map((role) => `${role.domain}|${role.userId}`));

  const store = {
    ...unboundDirectoryUserStore(),
    user: {
      findUnique: async (args: IdWhere) => users.get(args.where.id) ?? null,
      findMany: async (args: IdInWhere) =>
        [...users.values()].filter((user) => args.where.id.in.includes(user.id)),
    },
    userAvatar: {
      findUnique: async (args: UserIdWhere) => avatars.get(args.where.userId) ?? null,
      findMany: async (args: UserIdInWhere) =>
        [...avatars.values()].filter((row) => args.where.userId.in.includes(row.userId)),
      upsert: async (args: UpsertArgs) => {
        const existing = avatars.get(args.where.userId);
        const source = existing ? args.update : args.create;
        const next: StoredAvatar = {
          userId: args.where.userId,
          contentType: source.contentType,
          data: source.data,
          sizeBytes: source.sizeBytes,
          updatedAt: new Date('2026-07-25T10:00:00.000Z'),
        };
        avatars.set(next.userId, next);
        return next;
      },
      deleteMany: async (args: UserIdWhere) => ({
        count: avatars.delete(args.where.userId) ? 1 : 0,
      }),
    },
    domainRole: {
      findUnique: async (args: DomainRoleWhere) => {
        const { domain, userId } = args.where.domain_userId;
        return roles.has(`${domain}|${userId}`) ? { userId } : null;
      },
    },
  };

  return { avatars, prisma: store as unknown as NonNullable<AvatarDeps['prisma']> };
}

describe('avatar resolution precedence', () => {
  it('prefers the uploaded image over everything else', async () => {
    const { prisma } = fakePrisma({
      users: [{ id: 'u1', avatarUrl: 'https://cdn.example.com/a.png' }],
      avatars: [
        {
          userId: 'u1',
          contentType: 'image/webp',
          data: png(0x05),
          sizeBytes: 40,
          updatedAt: new Date(),
        },
      ],
    });
    const fetchProvider = vi.fn(async () => ({ contentType: 'image/png' as const, body: png() }));

    const avatar = await resolveAvatar({ userId: 'u1' }, { prisma, fetchProvider });

    expect(avatar.source).toBe('uploaded');
    expect(avatar.contentType).toBe('image/webp');
    expect(avatar.filename).toBe('avatar.webp');
    expect(avatar.cacheControl).toBe('private, max-age=300');
    expect(avatar.isSvg).toBe(false);
    // No provider round trip once an upload exists.
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it('proxies the provider URL when there is no upload', async () => {
    const { prisma } = fakePrisma({
      users: [{ id: 'u1', avatarUrl: 'https://cdn.example.com/a.png' }],
    });
    const body = jpeg();
    const fetchProvider = vi.fn(async () => ({ contentType: 'image/jpeg' as const, body }));

    const avatar = await resolveAvatar({ userId: 'u1' }, { prisma, fetchProvider });

    expect(fetchProvider).toHaveBeenCalledWith('https://cdn.example.com/a.png');
    expect(avatar.source).toBe('provider');
    expect(avatar.contentType).toBe('image/jpeg');
    expect(avatar.body.equals(body)).toBe(true);
    expect(avatar.cacheControl).toBe('private, max-age=300');
  });

  it('falls back to the generated image when the provider fetch fails', async () => {
    const { prisma } = fakePrisma({
      users: [{ id: 'u1', avatarUrl: 'https://cdn.example.com/dead.png' }],
    });
    const fetchProvider = vi.fn(async () => null);

    const avatar = await resolveAvatar({ userId: 'u1' }, { prisma, fetchProvider });

    expect(fetchProvider).toHaveBeenCalledOnce();
    expect(avatar.source).toBe('generated');
    expect(avatar.contentType).toBe('image/svg+xml; charset=utf-8');
    expect(avatar.cacheControl).toBe('private, max-age=86400');
    expect(avatar.isSvg).toBe(true);
    expect(avatar.filename).toBe('avatar.svg');
  });

  it('generates without any network call when the provider URL is null (e.g. Apple)', async () => {
    const { prisma } = fakePrisma({ users: [{ id: 'apple-user', avatarUrl: null }] });
    const fetchProvider = vi.fn(async () => null);

    const avatar = await resolveAvatar({ userId: 'apple-user' }, { prisma, fetchProvider });

    expect(fetchProvider).not.toHaveBeenCalled();
    expect(avatar.source).toBe('generated');
    expect(avatar.body.toString('utf8')).toContain('<svg');
  });

  it('applies the query override, then the config default, then the per-user pick', async () => {
    const { prisma } = fakePrisma({ users: [{ id: 'u1', avatarUrl: null }] });

    const overridden = await resolveAvatar(
      { userId: 'u1', style: 'waves', configDefaultStyle: 'mono' },
      { prisma },
    );
    const configured = await resolveAvatar({ userId: 'u1', configDefaultStyle: 'mono' }, { prisma });
    const fallback = await resolveAvatar({ userId: 'u1' }, { prisma });

    // mono is the only style with no hsl colours, which makes the selections distinguishable.
    expect(overridden.body.toString('utf8')).toMatch(/hsl\(/);
    expect(configured.body.toString('utf8')).not.toMatch(/hsl\(/);
    expect(fallback.body.toString('utf8')).toBe(
      (
        await resolveAvatar({ userId: 'u1', style: pickAvatarStyle('u1') }, { prisma })
      ).body.toString('utf8'),
    );
  });

  it('is a generic 404 for an unknown user', async () => {
    const { prisma } = fakePrisma();
    await expect(resolveAvatar({ userId: 'nope' }, { prisma })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('returns a stable ETag for identical bytes and a different one otherwise', async () => {
    const { prisma } = fakePrisma({ users: [{ id: 'u1', avatarUrl: null }] });

    const a = await resolveAvatar({ userId: 'u1', style: 'rings', size: 128 }, { prisma });
    const b = await resolveAvatar({ userId: 'u1', style: 'rings', size: 128 }, { prisma });
    const c = await resolveAvatar({ userId: 'u1', style: 'rings', size: 64 }, { prisma });

    expect(a.etag).toBe(b.etag);
    expect(a.etag).not.toBe(c.etag);
    expect(a.etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
  });
});

describe('upload validation', () => {
  it('stores the sniffed type, not the caller-supplied one', async () => {
    const { prisma, avatars } = fakePrisma({ users: [{ id: 'u1', avatarUrl: null }] });

    const result = await uploadAvatar({ userId: 'u1', data: jpeg() }, { prisma });

    expect(result.source).toBe('uploaded');
    expect(result.contentType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(jpeg().byteLength);
    expect(avatars.get('u1')?.contentType).toBe('image/jpeg');
  });

  it('rejects SVG, HTML and PDF uploads with a generic error', async () => {
    const { prisma } = fakePrisma({ users: [{ id: 'u1', avatarUrl: null }] });

    for (const payload of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<!doctype html><script>alert(1)</script>',
      '%PDF-1.7\n',
    ]) {
      await expect(
        uploadAvatar({ userId: 'u1', data: Buffer.from(payload, 'binary') }, { prisma }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('rejects an empty upload', async () => {
    const { prisma } = fakePrisma({ users: [{ id: 'u1', avatarUrl: null }] });
    await expect(
      uploadAvatar({ userId: 'u1', data: Buffer.alloc(0) }, { prisma }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects anything over the 1 MiB cap before sniffing', async () => {
    const { prisma } = fakePrisma({ users: [{ id: 'u1', avatarUrl: null }] });
    const oversize = png(0x02, AVATAR_MAX_BYTES + 1);

    await expect(uploadAvatar({ userId: 'u1', data: oversize }, { prisma })).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it('replaces an existing upload rather than adding a second row', async () => {
    const { prisma, avatars } = fakePrisma({ users: [{ id: 'u1', avatarUrl: null }] });

    await uploadAvatar({ userId: 'u1', data: png() }, { prisma });
    await uploadAvatar({ userId: 'u1', data: jpeg() }, { prisma });

    expect(avatars.size).toBe(1);
    expect(avatars.get('u1')?.contentType).toBe('image/jpeg');
  });

  it('is a generic 404 for an unknown user', async () => {
    const { prisma } = fakePrisma();
    await expect(uploadAvatar({ userId: 'nope', data: png() }, { prisma })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('delete and source reporting', () => {
  it('deletes idempotently and falls back to the provider afterwards', async () => {
    const { prisma, avatars } = fakePrisma({
      users: [{ id: 'u1', avatarUrl: 'https://cdn.example.com/a.png' }],
      avatars: [
        {
          userId: 'u1',
          contentType: 'image/png',
          data: png(),
          sizeBytes: 40,
          updatedAt: new Date(),
        },
      ],
    });
    const fetchProvider = vi.fn(async () => ({ contentType: 'image/png' as const, body: png() }));

    await deleteAvatar({ userId: 'u1' }, { prisma });
    await deleteAvatar({ userId: 'u1' }, { prisma });

    expect(avatars.size).toBe(0);
    expect((await resolveAvatar({ userId: 'u1' }, { prisma, fetchProvider })).source).toBe(
      'provider',
    );
  });

  it('reports the source per user without fetching bytes', async () => {
    const { prisma } = fakePrisma({
      users: [
        { id: 'uploaded', avatarUrl: 'https://cdn.example.com/a.png' },
        { id: 'provider', avatarUrl: 'https://cdn.example.com/b.png' },
        { id: 'generated', avatarUrl: null },
      ],
      avatars: [
        {
          userId: 'uploaded',
          contentType: 'image/png',
          data: png(),
          sizeBytes: 40,
          updatedAt: new Date(),
        },
      ],
    });

    const sources = await getAvatarSources(['uploaded', 'provider', 'generated'], { prisma });

    expect(sources.get('uploaded')).toBe('uploaded');
    expect(sources.get('provider')).toBe('provider');
    expect(sources.get('generated')).toBe('generated');
  });
});

describe('domain user visibility', () => {
  it('accepts a user with a role on the authenticated domain', async () => {
    const { prisma } = fakePrisma({
      users: [{ id: 'u1', avatarUrl: null }],
      roles: [{ domain: 'client.example.com', userId: 'u1' }],
    });

    await expect(
      requireDomainUserId({ domain: 'CLIENT.example.com ', userId: 'u1' }, { prisma }),
    ).resolves.toBe('u1');
  });

  it('is a generic 404 for a cross-domain or unknown user', async () => {
    const { prisma } = fakePrisma({
      users: [{ id: 'u1', avatarUrl: null }],
      roles: [{ domain: 'other.example.com', userId: 'u1' }],
    });

    await expect(
      requireDomainUserId({ domain: 'client.example.com', userId: 'u1' }, { prisma }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      requireDomainUserId({ domain: 'client.example.com', userId: 'ghost' }, { prisma }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('resolves the email and owning domain for the admin routes, 404 otherwise', async () => {
    const { prisma } = fakePrisma({
      users: [
        {
          id: 'u1',
          avatarUrl: null,
          email: 'target@example.com',
          domain: 'client.example.com',
        },
      ],
    });

    await expect(requireUserContext('u1', { prisma })).resolves.toEqual({
      userId: 'u1',
      email: 'target@example.com',
      domain: 'client.example.com',
    });
    await expect(requireUserContext('ghost', { prisma })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
