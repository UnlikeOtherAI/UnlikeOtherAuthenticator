import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { cleanClientDomains, seedDomainSecret } from '../helpers/domain-secret.js';
import { expectJsonError } from '../helpers/error-response.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const DOMAIN = 'client.example.com';
const CONFIG_URL = 'https://client.example.com/auth-config';
// A second seeded domain whose bearer is valid but whose config_url resolves to
// DOMAIN's config — the only way to reach the pre-hook's own domain gate
// (`assertVerifiedDomainMatchesQuery`), since config_url/config-domain
// agreement is checked by configVerifier and the bearer is checked before that.
const OTHER_DOMAIN = 'other.example.com';

function secretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

describe.skipIf(!hasDatabase)('GET /org/organisations/:orgId/invitations query handling', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalDebugEnabled = process.env.DEBUG_ENABLED;

  let app: Awaited<ReturnType<typeof createApp>>;
  let domainHash: string;
  let otherDomainHash: string;
  let orgId: string;
  let ownerToken: string;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;
    await handle.prisma.teamInvite.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
    await cleanClientDomains(handle.prisma);

    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({ org_features: { enabled: true } }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(configJwt)));

    app = await createApp();
    await app.ready();
    domainHash = await seedDomainSecret(handle.prisma, DOMAIN);
    otherDomainHash = await seedDomainSecret(handle.prisma, OTHER_DOMAIN);

    const owner = await handle.prisma.user.create({
      data: { email: 'owner@example.com', userKey: 'owner@example.com', passwordHash: null },
      select: { id: true },
    });
    const requester = await handle.prisma.user.create({
      data: { email: 'member@example.com', userKey: 'member@example.com', passwordHash: null },
      select: { id: true },
    });
    const org = await handle.prisma.organisation.create({
      data: { domain: DOMAIN, name: 'Acme', slug: 'acme', ownerId: owner.id, memberInvites: 'admin_approval' },
      select: { id: true },
    });
    orgId = org.id;
    await handle.prisma.orgMember.create({ data: { orgId, userId: owner.id, role: 'owner' } });

    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Team Alpha', slug: 'team-alpha' },
      select: { id: true },
    });
    await handle.prisma.teamInvite.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email: 'invitee@example.com',
        inviteName: 'Invitee',
        approvalStatus: 'PENDING',
        requestedByUserId: requester.id,
        lastSentAt: new Date(),
      },
    });

    ownerToken = await new SignJWT({
      email: 'owner@example.com',
      domain: DOMAIN,
      client_id: createClientId(DOMAIN, process.env.SHARED_SECRET!),
      role: 'user',
      org: { org_id: org.id, org_role: 'owner', teams: [], team_roles: {} },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(process.env.AUTH_SERVICE_IDENTIFIER!)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setSubject(owner.id)
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(secretKey(process.env.SHARED_SECRET!));
  });

  afterEach(async () => {
    if (app) await app.close();
    if (originalDebugEnabled === undefined) delete process.env.DEBUG_ENABLED;
    else process.env.DEBUG_ENABLED = originalDebugEnabled;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function invitationsUrl(extra = '', domain = DOMAIN): string {
    return `/org/organisations/${orgId}/invitations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(CONFIG_URL)}${extra}`;
  }

  function ownerHeaders(hash = domainHash): Record<string, string> {
    return { authorization: `Bearer ${hash}`, 'x-uoa-access-token': `Bearer ${ownerToken}` };
  }

  it('returns 200 and the pending queue for ?approval=pending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: invitationsUrl('&approval=pending'),
      headers: ownerHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ email: string; approvalStatus: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].email).toBe('invitee@example.com');
    expect(body.data[0].approvalStatus).toBe('pending');
  });

  it('returns 400 from the handler when ?approval=pending is omitted', async () => {
    // `/api` documents `approval` as required and pinned to "pending"; the point
    // of the fix is that the rejection now comes from the handler's own contract
    // rather than the pre-hook rejecting the parameter that makes the endpoint
    // work at all.
    const res = await app.inject({
      method: 'GET',
      url: invitationsUrl(),
      headers: ownerHeaders(),
    });

    expect(res.statusCode).toBe(400);
    expectJsonError(res.json());
  });

  it('rejects an unknown query key with 400 via the handler strict schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: invitationsUrl('&approval=pending&bogus=1'),
      headers: ownerHeaders(),
    });

    expect(res.statusCode).toBe(400);
    expectJsonError(res.json());
  });

  it('returns 401 for a ?domain= the bearer does not authenticate', async () => {
    const res = await app.inject({
      method: 'GET',
      url: invitationsUrl('&approval=pending', 'unknown.example.com'),
      headers: ownerHeaders(),
    });

    expect(res.statusCode).toBe(401);
  });

  it('still enforces the pre-hook domain gate when the verified config domain differs', async () => {
    // The bearer authenticates OTHER_DOMAIN and configVerifier happily verifies
    // DOMAIN's config (its `domain` claim matches its own config_url host).
    // Only `assertVerifiedDomainMatchesQuery` inside the pre-hook catches the
    // mismatch — and it must still run now that the hook schema is passthrough.
    // Error codes are only echoed in debug mode, so enable it to assert the
    // exact code rather than a bare 400; drop the gate and this request instead
    // reaches requireOrgRole and comes back 403.
    process.env.DEBUG_ENABLED = 'true';

    const res = await app.inject({
      method: 'GET',
      url: invitationsUrl('&approval=pending', OTHER_DOMAIN),
      headers: ownerHeaders(otherDomainHash),
    });

    expect(res.statusCode).toBe(400);
    expectJsonError(res.json(), { code: 'DOMAIN_MISMATCH' });
  });
});
