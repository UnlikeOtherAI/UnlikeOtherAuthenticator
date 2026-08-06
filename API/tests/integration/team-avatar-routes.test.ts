import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { cleanClientDomains, seedDomainSecret } from '../helpers/domain-secret.js';
import { expectJsonError } from '../helpers/error-response.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  signAccessToken,
} from '../helpers/org-user-endpoints-helper.js';
import { baseClientConfigPayload, signTestConfigJwt } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

/**
 * Team ("company") avatars end to end (Docs/Auth/avatars.md §11) — the team mirror of
 * `avatar-routes.test.ts`: the `/org/*` routes with their role enforcement, the domain-hash
 * backend route with its cross-domain 404, and the admin routes with their audit entries.
 */

const DOMAIN = 'team-avatars.example.com';
const OTHER_DOMAIN = 'other-team-avatars.example.com';
const ADMIN_DOMAIN = 'admin.example.com';
const ADMIN_SECRET = 'test-admin-token-secret-with-enough-length';
const CONFIG_URL = `https://${DOMAIN}/auth-config`;

const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

function png(fill = 0x21, length = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(length, fill),
  ]);
}

function multipartFile(file: Buffer, filename = 'avatar.png', contentType = 'image/png') {
  const boundary = '----uoa-team-avatar-test-boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe.skipIf(!hasDatabase)('team avatar routes', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let app: Awaited<ReturnType<typeof createApp>> | null = null;

  const original = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ADMIN_AUTH_DOMAIN: process.env.ADMIN_AUTH_DOMAIN,
    ADMIN_ACCESS_TOKEN_SECRET: process.env.ADMIN_ACCESS_TOKEN_SECRET,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');

    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET =
      process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.ADMIN_AUTH_DOMAIN = ADMIN_DOMAIN;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = ADMIN_SECRET;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;

    await handle.prisma.adminAuditLog.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await clearOrgTestDatabase(handle);
    await cleanClientDomains(handle.prisma);

    const configJwt = await createSignedConfigJwt(
      process.env.SHARED_SECRET!,
      { allow_user_create_org: true },
      DOMAIN,
    );
    // A fresh Response per call: bodies are single-use and every /org/* request refetches it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(configJwt, { status: 200 })));

    app = await createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Owner-created org + team, plus a plain org member, all through the real routes. */
  async function seedWorkspace() {
    const domainHash = await seedDomainSecret(handle!.prisma, DOMAIN);
    const owner = await createTestUser(handle!, 'team-avatar-owner@example.com');
    const member = await createTestUser(handle!, 'team-avatar-member@example.com');

    const secret = process.env.SHARED_SECRET!;
    const issuer = process.env.AUTH_SERVICE_IDENTIFIER!;
    const ownerBaseToken = await signAccessToken({ subject: owner.id, domain: DOMAIN, secret, issuer });

    const query = `domain=${encodeURIComponent(DOMAIN)}&config_url=${encodeURIComponent(CONFIG_URL)}`;
    const createOrg = await app!.inject({
      method: 'POST',
      url: `/org/organisations?${query}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerBaseToken}`,
      },
      payload: { name: 'Avatar Co' },
    });
    expect(createOrg.statusCode).toBe(200);
    const org = createOrg.json() as { id: string };

    const ownerToken = await signAccessToken({
      subject: owner.id,
      domain: DOMAIN,
      secret,
      issuer,
      org: { orgId: org.id, orgRole: 'owner' },
    });

    const addMember = await app!.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/members?${query}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { userId: member.id },
    });
    expect(addMember.statusCode).toBe(200);

    const memberToken = await signAccessToken({
      subject: member.id,
      domain: DOMAIN,
      secret,
      issuer,
      org: { orgId: org.id, orgRole: 'member' },
    });

    const createTeam = await app!.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams?${query}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { name: 'Engineering' },
    });
    expect(createTeam.statusCode).toBe(200);
    const team = createTeam.json() as { id: string; avatarImageUrl: string; iconUrl: string | null };

    return { domainHash, org, team, ownerToken, memberToken, query };
  }

  async function seedAdminToken(): Promise<string> {
    const admin = await createTestUser(handle!, 'team-avatar-admin@example.com');
    await handle!.prisma.domainRole.create({
      data: { domain: ADMIN_DOMAIN, userId: admin.id, role: 'SUPERUSER' },
    });
    return await signAccessToken({
      subject: admin.id,
      domain: ADMIN_DOMAIN,
      secret: ADMIN_SECRET,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      email: 'team-avatar-admin@example.com',
      role: 'superuser',
    });
  }

  describe('GET/PUT/DELETE /org/organisations/:orgId/teams/:teamId/avatar', () => {
    it('round-trips an upload for an owner and falls back to generated after delete', async () => {
      const { domainHash, org, team, ownerToken, query } = await seedWorkspace();
      const url = `/org/organisations/${org.id}/teams/${team.id}/avatar?${query}`;
      const headers = {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      };

      // Docs/Auth/avatars.md §11.4 — the created team already carries a derived, non-null URL.
      expect(team.avatarImageUrl).toBe(
        `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
      );
      expect(team.iconUrl).toBeNull();

      const generated = await app!.inject({ method: 'GET', url, headers });
      expect(generated.statusCode).toBe(200);
      expect(generated.headers['x-uoa-avatar-source']).toBe('generated');
      expect(generated.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
      expect(generated.headers['cache-control']).toBe('private, max-age=86400');
      expect(generated.headers['x-content-type-options']).toBe('nosniff');
      expect(generated.headers['content-disposition']).toBe('inline; filename="avatar.svg"');
      expect(generated.headers['content-security-policy']).toBe(SVG_CSP);
      expect(generated.body).toContain('<svg');

      const notModified = await app!.inject({
        method: 'GET',
        url,
        headers: { ...headers, 'if-none-match': String(generated.headers.etag) },
      });
      expect(notModified.statusCode).toBe(304);

      const bytes = png();
      const upload = multipartFile(bytes);
      const put = await app!.inject({
        method: 'PUT',
        url,
        headers: { ...headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({
        ok: true,
        avatar: { source: 'uploaded', content_type: 'image/png', size_bytes: bytes.byteLength },
      });

      const uploaded = await app!.inject({ method: 'GET', url, headers });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.headers['x-uoa-avatar-source']).toBe('uploaded');
      expect(uploaded.headers['content-type']).toBe('image/png');
      expect(uploaded.headers['cache-control']).toBe('private, max-age=300');
      expect(uploaded.headers['content-disposition']).toBe('inline; filename="avatar.png"');
      expect(uploaded.rawPayload.equals(bytes)).toBe(true);

      for (const expected of [200, 200]) {
        const del = await app!.inject({ method: 'DELETE', url, headers });
        expect(del.statusCode).toBe(expected);
        expect(del.json()).toEqual({ ok: true });
      }

      const afterDelete = await app!.inject({ method: 'GET', url, headers });
      expect(afterDelete.headers['x-uoa-avatar-source']).toBe('generated');
      expect(await handle!.prisma.teamAvatar.count()).toBe(0);
    });

    it('honours ?style= and ?size= on the generated image', async () => {
      const { domainHash, org, team, ownerToken, query } = await seedWorkspace();

      const mono = await app!.inject({
        method: 'GET',
        url: `/org/organisations/${org.id}/teams/${team.id}/avatar?${query}&style=mono&size=64`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${ownerToken}`,
        },
      });

      expect(mono.statusCode).toBe(200);
      expect(mono.body).toContain('width="64" height="64"');
      expect(mono.body).toContain('viewBox="0 0 100 100"');
      expect(mono.body).not.toContain('hsl(');
    });

    it('lets a plain org member read but not write', async () => {
      const { domainHash, org, team, memberToken, query } = await seedWorkspace();
      const url = `/org/organisations/${org.id}/teams/${team.id}/avatar?${query}`;
      const headers = {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${memberToken}`,
      };

      const read = await app!.inject({ method: 'GET', url, headers });
      expect(read.statusCode).toBe(200);
      expect(read.headers['x-uoa-avatar-source']).toBe('generated');

      const upload = multipartFile(png(0x55));
      const put = await app!.inject({
        method: 'PUT',
        url,
        headers: { ...headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(403);
      expectJsonError(put.json());

      const del = await app!.inject({ method: 'DELETE', url, headers });
      expect(del.statusCode).toBe(403);
      expectJsonError(del.json());

      expect(await handle!.prisma.teamAvatar.count()).toBe(0);
    });

    it('rejects an SVG upload and a missing access token', async () => {
      const { domainHash, org, team, ownerToken, query } = await seedWorkspace();
      const url = `/org/organisations/${org.id}/teams/${team.id}/avatar?${query}`;

      const upload = multipartFile(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        'avatar.svg',
        // Lie about the type: the sniffed verdict is what counts.
        'image/png',
      );
      const svg = await app!.inject({
        method: 'PUT',
        url,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${ownerToken}`,
          'content-type': upload.contentType,
        },
        payload: upload.body,
      });
      expect(svg.statusCode).toBe(400);
      expectJsonError(svg.json());
      expect(await handle!.prisma.teamAvatar.count()).toBe(0);

      const noToken = await app!.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${domainHash}` },
      });
      expect(noToken.statusCode).toBe(401);
      expectJsonError(noToken.json());
    });

    it('is a generic 404 for a team that belongs to another organisation', async () => {
      const { domainHash, org, ownerToken, query } = await seedWorkspace();

      const res = await app!.inject({
        method: 'GET',
        url: `/org/organisations/${org.id}/teams/team_does_not_exist/avatar?${query}`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${ownerToken}`,
        },
      });

      expect(res.statusCode).toBe(404);
      expectJsonError(res.json());
    });
  });

  describe('GET/PUT/DELETE /domain/teams/:teamId/avatar', () => {
    it('serves image bytes with the domain hash bearer alone', async () => {
      const { domainHash, org, team, ownerToken, query } = await seedWorkspace();

      // Upload through the /org route, then read it back through the backend route.
      const upload = multipartFile(png(0x66));
      const put = await app!.inject({
        method: 'PUT',
        url: `/org/organisations/${org.id}/teams/${team.id}/avatar?${query}`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${ownerToken}`,
          'content-type': upload.contentType,
        },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);

      const res = await app!.inject({
        method: 'GET',
        url: `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: `Bearer ${domainHash}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-uoa-avatar-source']).toBe('uploaded');
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.rawPayload.equals(png(0x66))).toBe(true);
    });

    it('manages the avatar with the domain hash alone — no access token, no role check', async () => {
      const { domainHash, team } = await seedWorkspace();
      const url = `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`;
      const headers = { authorization: `Bearer ${domainHash}` };

      // Brief §24.10: the domain hash bearer is full system trust for that domain, so the backend
      // relays without an end-user access token and no org role is consulted.
      const bytes = png(0x88);
      const upload = multipartFile(bytes);
      const put = await app!.inject({
        method: 'PUT',
        url,
        headers: { ...headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({
        ok: true,
        avatar: { source: 'uploaded', content_type: 'image/png', size_bytes: bytes.byteLength },
      });

      const uploaded = await app!.inject({ method: 'GET', url, headers });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.headers['x-uoa-avatar-source']).toBe('uploaded');
      expect(uploaded.rawPayload.equals(bytes)).toBe(true);

      for (const expected of [200, 200]) {
        const del = await app!.inject({ method: 'DELETE', url, headers });
        expect(del.statusCode).toBe(expected);
        expect(del.json()).toEqual({ ok: true });
      }

      const afterDelete = await app!.inject({ method: 'GET', url, headers });
      expect(afterDelete.headers['x-uoa-avatar-source']).toBe('generated');
      expect(await handle!.prisma.teamAvatar.count()).toBe(0);
    });

    it('still applies avatars.default_style from a verified config_url once authenticated', async () => {
      // The config hook now runs AFTER the bearer check. That is about anonymous callers, not about
      // dropping the feature — an authenticated caller must still get its configured default style.
      const { domainHash, team } = await seedWorkspace();
      const headers = { authorization: `Bearer ${domainHash}` };
      const base = `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`;

      // Two styles, because the id-derived default can only ever equal one of them: if the config
      // were being ignored, at least one iteration would return that default instead.
      for (const style of ['mono', 'waves'] as const) {
        const styledConfig = await signTestConfigJwt(
          baseClientConfigPayload({
            domain: DOMAIN,
            redirect_urls: [`https://${DOMAIN}/oauth/callback`],
            avatars: { default_style: style },
          }),
        );
        vi.stubGlobal('fetch', vi.fn(async () => new Response(styledConfig, { status: 200 })));

        const viaConfig = await app!.inject({
          method: 'GET',
          url: `${base}&config_url=${encodeURIComponent(CONFIG_URL)}`,
          headers,
        });
        const explicit = await app!.inject({
          method: 'GET',
          url: `${base}&style=${style}`,
          headers,
        });

        expect(viaConfig.statusCode).toBe(200);
        expect(explicit.statusCode).toBe(200);
        expect(viaConfig.headers['x-uoa-avatar-source']).toBe('generated');
        expect(viaConfig.body).toBe(explicit.body);
      }
    });

    it('audit-logs the backend upload and delete against the acting domain', async () => {
      // The backend route enforces no role of its own, so the audit row is the only record of
      // which tenant changed a workspace logo. `/internal/admin/*` has always had one.
      const { domainHash, team } = await seedWorkspace();
      const url = `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`;
      const headers = { authorization: `Bearer ${domainHash}` };
      const upload = multipartFile(png(0x44));

      const put = await app!.inject({
        method: 'PUT',
        url,
        headers: { ...headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);

      const del = await app!.inject({ method: 'DELETE', url, headers });
      expect(del.statusCode).toBe(200);

      const updated = await handle!.prisma.adminAuditLog.findMany({
        where: { action: 'domain.team_avatar_updated' },
      });
      const deleted = await handle!.prisma.adminAuditLog.findMany({
        where: { action: 'domain.team_avatar_deleted' },
      });

      expect(updated).toHaveLength(1);
      expect(deleted).toHaveLength(1);
      expect(updated[0].targetDomain).toBe(DOMAIN);
      expect(updated[0].metadata).toMatchObject({ teamId: team.id, contentType: 'image/png' });
      expect(deleted[0].metadata).toMatchObject({ teamId: team.id });

      const clientDomain = await handle!.prisma.clientDomain.findUnique({
        where: { domain: DOMAIN },
        select: { id: true },
      });

      for (const row of [...updated, ...deleted]) {
        // The actor is a client backend, not a person: the row must never read as an address, and
        // it names the ClientDomain row rather than the credential that authenticated the call.
        expect(row.actorEmail).toBe(`client:${DOMAIN}#${clientDomain!.id}`);
        // `domainHash` IS the live domain-hash bearer — full system trust for this domain. It must
        // not reach an operator-readable table in any field.
        expect(JSON.stringify(row)).not.toContain(domainHash);
      }
    });

    it('rejects an SVG upload on the backend path with a generic error', async () => {
      const { domainHash, team } = await seedWorkspace();
      const upload = multipartFile(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        'avatar.svg',
        'image/png',
      );

      const res = await app!.inject({
        method: 'PUT',
        url: `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: `Bearer ${domainHash}`, 'content-type': upload.contentType },
        payload: upload.body,
      });

      expect(res.statusCode).toBe(400);
      expectJsonError(res.json());
      expect(await handle!.prisma.teamAvatar.count()).toBe(0);
    });

    it('refuses cross-domain mutations with the same generic 404 as the read', async () => {
      const { team } = await seedWorkspace();
      const otherHash = await seedDomainSecret(handle!.prisma, OTHER_DOMAIN);
      const url = `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(OTHER_DOMAIN)}`;
      const upload = multipartFile(png(0x99));

      const put = await app!.inject({
        method: 'PUT',
        url,
        headers: { authorization: `Bearer ${otherHash}`, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(404);
      expectJsonError(put.json());

      const del = await app!.inject({
        method: 'DELETE',
        url,
        headers: { authorization: `Bearer ${otherHash}` },
      });
      expect(del.statusCode).toBe(404);
      expectJsonError(del.json());

      const unauthenticated = await app!.inject({
        method: 'DELETE',
        url: `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: 'Bearer invalid' },
      });
      expect(unauthenticated.statusCode).toBe(401);
      expectJsonError(unauthenticated.json());

      expect(await handle!.prisma.teamAvatar.count()).toBe(0);
    });

    it('returns a generic 404 for unknown and cross-domain team ids, and 401 for a bad hash', async () => {
      const { team } = await seedWorkspace();
      const otherHash = await seedDomainSecret(handle!.prisma, OTHER_DOMAIN);

      // The team exists, but its organisation is not on the authenticated domain.
      const crossDomain = await app!.inject({
        method: 'GET',
        url: `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(OTHER_DOMAIN)}`,
        headers: { authorization: `Bearer ${otherHash}` },
      });
      expect(crossDomain.statusCode).toBe(404);
      expectJsonError(crossDomain.json());

      const unknown = await app!.inject({
        method: 'GET',
        url: `/domain/teams/team_nope/avatar?domain=${encodeURIComponent(OTHER_DOMAIN)}`,
        headers: { authorization: `Bearer ${otherHash}` },
      });
      expect(unknown.statusCode).toBe(404);
      expectJsonError(unknown.json());

      const badHash = await app!.inject({
        method: 'GET',
        url: `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: 'Bearer invalid' },
      });
      expect(badHash.statusCode).toBe(401);
      expectJsonError(badHash.json());
    });
  });

  describe('GET /teams/:teamId/avatar (public)', () => {
    it('serves the workspace image with no credential at all', async () => {
      const { domainHash, team, query } = await seedWorkspace();

      const generated = await app!.inject({ method: 'GET', url: `/teams/${team.id}/avatar` });
      expect(generated.statusCode).toBe(200);
      expect(generated.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
      expect(generated.headers['x-content-type-options']).toBe('nosniff');
      expect(generated.headers['content-security-policy']).toBe(SVG_CSP);
      // Anonymous callers do not get to learn whether this workspace uploaded a logo.
      expect(generated.headers['x-uoa-avatar-source']).toBeUndefined();

      const bytes = png(0x5a);
      const upload = multipartFile(bytes);
      const put = await app!.inject({
        method: 'PUT',
        url: `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: `Bearer ${domainHash}`, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);

      // The uploaded image is now readable by anyone holding the team id — the accepted trade
      // (Docs/Auth/avatars.md §11.3) that lets the chooser render a real logo.
      const uploaded = await app!.inject({ method: 'GET', url: `/teams/${team.id}/avatar` });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.headers['x-uoa-avatar-source']).toBeUndefined();
      expect(uploaded.rawPayload.equals(bytes)).toBe(true);

      expect(query).toBeTruthy();
    });

    it('stops serving a real logo once the owning domain is no longer active', async () => {
      const { domainHash, team } = await seedWorkspace();

      const bytes = png(0x3c);
      const upload = multipartFile(bytes);
      const put = await app!.inject({
        method: 'PUT',
        url: `/domain/teams/${team.id}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: `Bearer ${domainHash}`, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);

      await handle!.prisma.clientDomain.update({
        where: { domain: DOMAIN },
        data: { status: 'disabled' },
      });

      // Not a 404 — a torn-down tenant must look like a workspace that never set a logo, or the
      // route becomes the existence oracle it is designed not to be.
      const after = await app!.inject({ method: 'GET', url: `/teams/${team.id}/avatar` });
      expect(after.statusCode).toBe(200);
      expect(after.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
      expect(after.rawPayload.equals(bytes)).toBe(false);

      const unknown = await app!.inject({ method: 'GET', url: `/teams/${team.id}-nope/avatar` });
      expect(unknown.statusCode).toBe(200);
    });

    it('is not an existence oracle — an unknown team id renders the same generated image', async () => {
      const unknown = await app!.inject({ method: 'GET', url: '/teams/team_does_not_exist/avatar' });
      expect(unknown.statusCode).toBe(200);
      expect(unknown.headers['x-uoa-avatar-source']).toBeUndefined();
      expect(unknown.body).toContain('<svg');

      // Deterministic per id, exactly like a real team's generated image: same id, same bytes.
      const again = await app!.inject({ method: 'GET', url: '/teams/team_does_not_exist/avatar' });
      expect(again.body).toBe(unknown.body);

      const other = await app!.inject({ method: 'GET', url: '/teams/team_other_unknown/avatar' });
      expect(other.statusCode).toBe(200);
      expect(other.body).not.toBe(unknown.body);
    });

    it('honours ?style= and ?size= but takes no config_url', async () => {
      const { team } = await seedWorkspace();

      const styled = await app!.inject({
        method: 'GET',
        url: `/teams/${team.id}/avatar?style=rings&size=128`,
      });
      expect(styled.statusCode).toBe(200);
      expect(styled.body).toContain('width="128"');

      // A public caller must not be able to aim the config fetcher at a URL of its choosing.
      const withConfig = await app!.inject({
        method: 'GET',
        url: `/teams/${team.id}/avatar?config_url=${encodeURIComponent(CONFIG_URL)}`,
      });
      expect(withConfig.statusCode).toBe(400);
    });
  });

  describe('GET/PUT/DELETE /internal/admin/teams/:teamId/avatar', () => {
    it('serves, replaces and clears any team avatar, writing audit entries', async () => {
      const { team } = await seedWorkspace();
      const adminToken = await seedAdminToken();
      const url = `/internal/admin/teams/${team.id}/avatar`;
      const headers = { authorization: `Bearer ${adminToken}` };

      const generated = await app!.inject({ method: 'GET', url, headers });
      expect(generated.statusCode).toBe(200);
      expect(generated.headers['x-uoa-avatar-source']).toBe('generated');
      expect(generated.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
      expect(generated.body).toContain('<svg');

      const bytes = png(0x77);
      const upload = multipartFile(bytes);
      const put = await app!.inject({
        method: 'PUT',
        url,
        headers: { ...headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ ok: true, avatar: { source: 'uploaded' } });

      const uploaded = await app!.inject({ method: 'GET', url, headers });
      expect(uploaded.headers['x-uoa-avatar-source']).toBe('uploaded');
      expect(uploaded.rawPayload.equals(bytes)).toBe(true);

      for (const expected of [200, 200]) {
        const del = await app!.inject({ method: 'DELETE', url, headers });
        expect(del.statusCode).toBe(expected);
        expect(del.json()).toEqual({ ok: true });
      }
      expect(await handle!.prisma.teamAvatar.count()).toBe(0);

      const audit = await handle!.prisma.adminAuditLog.findMany({
        where: { action: { in: ['team.avatar_updated', 'team.avatar_deleted'] } },
        select: { action: true, targetDomain: true, actorEmail: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual([
        'team.avatar_updated',
        'team.avatar_deleted',
        'team.avatar_deleted',
      ]);
      expect(new Set(audit.map((row) => row.targetDomain))).toEqual(new Set([DOMAIN]));
      expect(new Set(audit.map((row) => row.actorEmail))).toEqual(
        new Set(['team-avatar-admin@example.com']),
      );
    });

    it('returns 401 without a bearer, 403 for a non-superuser, and 404 for an unknown team', async () => {
      const { team } = await seedWorkspace();
      const adminToken = await seedAdminToken();

      const anonymous = await app!.inject({
        method: 'GET',
        url: `/internal/admin/teams/${team.id}/avatar`,
      });
      expect(anonymous.statusCode).toBe(401);
      expectJsonError(anonymous.json());

      const plainUser = await createTestUser(handle!, 'not-an-admin@example.com');
      const plainToken = await signAccessToken({
        subject: plainUser.id,
        domain: ADMIN_DOMAIN,
        secret: ADMIN_SECRET,
        issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
        email: 'not-an-admin@example.com',
        role: 'user',
      });
      const forbidden = await app!.inject({
        method: 'GET',
        url: `/internal/admin/teams/${team.id}/avatar`,
        headers: { authorization: `Bearer ${plainToken}` },
      });
      expect(forbidden.statusCode).toBe(403);
      expectJsonError(forbidden.json());

      const unknown = await app!.inject({
        method: 'GET',
        url: '/internal/admin/teams/team_nope/avatar',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(unknown.statusCode).toBe(404);
      expectJsonError(unknown.json());
    });
  });
});
