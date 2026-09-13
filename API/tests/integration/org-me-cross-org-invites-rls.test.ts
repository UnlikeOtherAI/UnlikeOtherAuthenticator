// `GET /org/me` must report an invitation into an organisation the caller's access token is NOT
// scoped to. Reproduces the production shape reported on 2026-09-13 (client domain
// api.nessie.works): two organisations founded on ONE client domain — one through the hosted
// chooser's `POST /auth/create-organisation`, one through the product's `POST /org/organisations`
// — one user active in both, and a pending invitation sitting in the organisation the token does
// not name. The hosted chooser offered that invitation at sign-in; `/org/me` answered
// `pending_invites: []`, so the product had nothing to render.
//
// This file connects as the PRODUCTION RLS roles on purpose. Under the Postgres superuser the
// defect is invisible: `team_invites_select` is `org_id = app.org_id` and nothing else
// (20260423000001_rls_enable_policies), and `/org/me` puts the token's own organisation into that
// GUC — so the read silently returned zero rows for every sibling organisation. A superuser
// bypasses RLS entirely and the same code passes.
import { createHash, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { hashPassword } from '../../src/services/password.service.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createRlsTestDb } from '../helpers/test-db.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';
import {
  clearOrgTestDatabase,
  hasDatabase,
  signAccessToken,
  type OrgRecord,
} from '../helpers/org-user-endpoints-helper.js';

const DOMAIN = 'client.example.com';
const CONFIG_URL = 'https://client.example.com/auth-config';
const REDIRECT_URL = 'https://client.example.com/oauth/callback';
const PKCE =
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';
const PASSWORD = 'Abcdef1!';

const USER_A = 'cross-org-a@example.com';
const USER_B = 'cross-org-b@example.com';

type SidebarInvite = {
  inviteId: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  teamId: string;
  teamName: string;
  invitedBy: string | null;
  expiresAt: string | null;
};

type MeBody = {
  ok: true;
  org?: {
    org_id: string;
    team_directory: { teamId: string; orgId: string; orgName: string }[];
    pending_invites: SidebarInvite[];
  };
};

type ChooserBody = {
  login_token?: string;
  pending_invites?: { inviteId: string; teamName: string; orgName: string | null }[];
};

describe.skipIf(!hasDatabase)('/org/me cross-organisation pending invites (uoa_app)', () => {
  let handle: Awaited<ReturnType<typeof createRlsTestDb>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let domainHash: string;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAdminUrl = process.env.DATABASE_ADMIN_URL;

  beforeAll(async () => {
    handle = await createRlsTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    // The app runs as the real RLS role; only this file's own seeding uses `handle.prisma`.
    process.env.DATABASE_URL = handle.appDatabaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.adminDatabaseUrl;
  });

  afterAll(async () => {
    await disconnectPrisma();
    process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalAdminUrl === undefined) delete process.env.DATABASE_ADMIN_URL;
    else process.env.DATABASE_ADMIN_URL = originalAdminUrl;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET =
      process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    if (!handle) return;

    await handle.prisma.billingAppKey.deleteMany();
    await handle.prisma.billingService.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.refreshToken.deleteMany();
    await handle.prisma.orgAuditLog.deleteMany();
    await clearOrgTestDatabase(handle);

    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({
        org_features: {
          enabled: true,
          allow_user_create_org: true,
          allow_user_create_team: true,
        },
        login_flow: { team_selection: 'auto' },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(configJwt)));

    app = await createApp();
    await app.ready();
    domainHash = await seedDomainSecret(handle.prisma, DOMAIN);
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function createUser(email: string, name?: string): Promise<{ id: string }> {
    return handle!.prisma.user.create({
      data: {
        email,
        userKey: email,
        passwordHash: await hashPassword(PASSWORD),
        ...(name ? { name } : {}),
      },
      select: { id: true },
    });
  }

  /** The hosted chooser's own bridge token, from a real password sign-in. */
  async function signInForChooser(email: string): Promise<ChooserBody> {
    const res = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(CONFIG_URL)}&redirect_url=${encodeURIComponent(REDIRECT_URL)}${PKCE}`,
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as ChooserBody;
  }

  function orgUrl(path: string): string {
    return `${path}?domain=${encodeURIComponent(DOMAIN)}&config_url=${encodeURIComponent(CONFIG_URL)}`;
  }

  function headers(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${domainHash}`,
      'x-uoa-access-token': `Bearer ${accessToken}`,
    };
  }

  async function tokenFor(params: {
    userId: string;
    email: string;
    org?: { orgId: string; orgRole: string; teams?: string[]; team_roles?: Record<string, string> };
  }): Promise<string> {
    return signAccessToken({
      subject: params.userId,
      domain: DOMAIN,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      email: params.email,
      ...(params.org ? { org: params.org } : {}),
    });
  }

  it('lists an invitation from the organisation the access token is not scoped to', async () => {
    const userA = await createUser(USER_A);
    const userB = await createUser(USER_B, 'Test B');

    // 1. A founds "Alpha Team" the way the hosted first-login chooser does.
    const chooser = await signInForChooser(USER_A);
    expect(chooser.login_token, 'password sign-in should reach the chooser').toBeTruthy();

    const created = await app.inject({
      method: 'POST',
      url: `/auth/create-organisation?config_url=${encodeURIComponent(CONFIG_URL)}&redirect_url=${encodeURIComponent(REDIRECT_URL)}${PKCE}`,
      payload: { login_token: chooser.login_token, name: 'Alpha Team' },
    });
    expect(created.statusCode, created.body).toBe(200);

    const alpha = await handle!.prisma.organisation.findFirstOrThrow({
      where: { name: 'Alpha Team' },
      select: { id: true, domain: true, teams: { select: { id: true, name: true } } },
    });
    const alphaGeneral = alpha.teams.find((team) => team.name === 'General')!;

    // 2. B founds "Bravo Org" the way the product does, on the SAME client domain.
    const bTokenUnscoped = await tokenFor({ userId: userB.id, email: USER_B });
    const createBravo = await app.inject({
      method: 'POST',
      url: orgUrl('/org/organisations'),
      headers: headers(bTokenUnscoped),
      payload: { name: 'Bravo Org' },
    });
    expect(createBravo.statusCode, createBravo.body).toBe(200);
    const bravo = createBravo.json() as OrgRecord & { defaultTeam: { id: string } };
    // The defect is not a domain mismatch between the two creation routes: both organisations
    // are founded on the caller's own client domain. Pin that, so a future change to either
    // route cannot make this test pass for the wrong reason.
    expect(bravo.domain).toBe(alpha.domain);

    const bToken = await tokenFor({
      userId: userB.id,
      email: USER_B,
      org: {
        orgId: bravo.id,
        orgRole: 'owner',
        teams: [bravo.defaultTeam.id],
        team_roles: { [bravo.defaultTeam.id]: 'owner' },
      },
    });

    // 3. B adds A to Bravo Org and invites A into a further team of it.
    const addMember = await app.inject({
      method: 'POST',
      url: orgUrl(`/org/organisations/${bravo.id}/members`),
      headers: headers(bToken),
      payload: { userId: userA.id, role: 'member' },
    });
    expect(addMember.statusCode, addMember.body).toBe(200);

    const bravoThree = await app.inject({
      method: 'POST',
      url: orgUrl(`/org/organisations/${bravo.id}/teams`),
      headers: headers(bToken),
      payload: { name: 'Bravo Three', join_creator: true },
    });
    expect(bravoThree.statusCode, bravoThree.body).toBe(200);
    const bravoThreeTeam = bravoThree.json() as { id: string };

    const invited = await app.inject({
      method: 'POST',
      url: orgUrl(`/org/organisations/${bravo.id}/teams/${bravoThreeTeam.id}/invitations`),
      headers: headers(bToken),
      payload: { email: USER_A, name: 'Cross Org A' },
    });
    expect(invited.statusCode, invited.body).toBe(200);

    const inviteRow = await handle!.prisma.teamInvite.findFirstOrThrow({
      where: { email: USER_A, teamId: bravoThreeTeam.id },
      select: { id: true },
    });

    // 4. A asks the product for its context with a token scoped to ALPHA — the exact shape the
    //    production run captured. The invitation lives in Bravo.
    const aToken = await tokenFor({
      userId: userA.id,
      email: USER_A,
      org: {
        orgId: alpha.id,
        orgRole: 'owner',
        teams: [alphaGeneral.id],
        team_roles: { [alphaGeneral.id]: 'owner' },
      },
    });

    const me = await app.inject({
      method: 'GET',
      url: orgUrl('/org/me'),
      headers: headers(aToken),
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as MeBody;

    expect(body.org?.org_id).toBe(alpha.id);
    expect(body.org?.pending_invites).toEqual([
      {
        inviteId: inviteRow.id,
        orgId: bravo.id,
        orgName: 'Bravo Org',
        orgSlug: bravo.slug,
        teamId: bravoThreeTeam.id,
        teamName: 'Bravo Three',
        // A member-initiated invitation stores only `invitedByUserId`; the label is the inviting
        // user's NAME, resolved at read time.
        invitedBy: 'Test B',
        expiresAt: expect.any(String),
      },
    ]);
    // And never the inviter's address: the invitation e-mail does not disclose it either.
    expect(me.body).not.toContain(USER_B);

    // A holds no team membership in Bravo — only the invitation — so the directory is Alpha's
    // alone here. The invitation is therefore the ONLY place the product can learn that Bravo
    // exists for this person, which is why dropping it hid the organisation entirely.
    expect(body.org?.team_directory.map((entry) => entry.orgName)).toEqual(['Alpha Team']);

    // 5. The hosted chooser answers for the same person on the same sign-in. Both surfaces must
    //    now name the same invitation AND the organisation it comes from.
    const secondSignIn = await signInForChooser(USER_A);
    expect(secondSignIn.pending_invites).toEqual([
      {
        inviteId: inviteRow.id,
        teamName: 'Bravo Three',
        orgName: 'Bravo Org',
        invitedBy: 'Test B',
      },
    ]);
  });

  /**
   * Make this domain an `all_active_memberships` product, the way Nessie is: an active
   * ClientDomain that is the exact actor issuer of one current CUSTOMER_LIFECYCLE key of one
   * active billing service. Nothing in the signed client config can opt a domain in.
   */
  async function mapDomainToProduct(): Promise<void> {
    const service = await handle!.prisma.billingService.create({
      data: { identifier: `cross-org-${randomUUID()}`, name: DOMAIN },
      select: { id: true },
    });
    await handle!.prisma.billingAppKey.create({
      data: {
        actorAudience: 'https://authentication.example/billing/v1/effective-tariff',
        actorIssuer: `https://${DOMAIN}`,
        actorKeyId: `cross-org-${randomUUID()}`,
        actorPublicJwk: {},
        checkoutReturnOrigins: [`https://${DOMAIN}`],
        keyPrefix: `xorg_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        name: DOMAIN,
        purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
        secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        serviceId: service.id,
      },
    });
  }

  /** An organisation founded through ANOTHER product's domain, with a pending invitation in it. */
  async function seedOffDomainInvite(userId: string, email: string): Promise<{ inviteId: string }> {
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: 'other.example.com',
        name: 'Charlie Corp',
        slug: 'charlie-corp',
        ownerId: userId,
        members: { create: { userId, role: 'owner', status: 'ACTIVE' } },
      },
      select: { id: true },
    });
    const team = await handle!.prisma.team.create({
      data: { orgId: org.id, name: 'Charlie One', slug: 'charlie-one' },
      select: { id: true },
    });
    const invite = await handle!.prisma.teamInvite.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email,
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      select: { id: true },
    });
    return { inviteId: invite.id };
  }

  // The two surfaces have to answer with ONE set. They did not: `/org/me` reached the policy's
  // organisations while the chooser's own query was still domain-scoped, so an
  // `all_active_memberships` product could be offered an invitation at sign-in that the product
  // never saw — or, after the sidebar fix alone, the reverse.
  it('answers with the same invitations as the chooser for an all-memberships product', async () => {
    const userA = await createUser(USER_A);
    await mapDomainToProduct();

    const chooser = await signInForChooser(USER_A);
    expect(chooser.login_token).toBeTruthy();
    const created = await app.inject({
      method: 'POST',
      url: `/auth/create-organisation?config_url=${encodeURIComponent(CONFIG_URL)}&redirect_url=${encodeURIComponent(REDIRECT_URL)}${PKCE}`,
      payload: { login_token: chooser.login_token, name: 'Alpha Team' },
    });
    expect(created.statusCode, created.body).toBe(200);

    const alpha = await handle!.prisma.organisation.findFirstOrThrow({
      where: { name: 'Alpha Team' },
      select: { id: true, teams: { select: { id: true, name: true } } },
    });
    const alphaGeneral = alpha.teams.find((team) => team.name === 'General')!;

    // An invitation in an organisation founded on a DIFFERENT domain, which this user is an
    // ACTIVE member of — reachable only under the all-memberships policy.
    const offDomain = await seedOffDomainInvite(userA.id, USER_A);

    const aToken = await tokenFor({
      userId: userA.id,
      email: USER_A,
      org: {
        orgId: alpha.id,
        orgRole: 'owner',
        teams: [alphaGeneral.id],
        team_roles: { [alphaGeneral.id]: 'owner' },
      },
    });

    const me = await app.inject({ method: 'GET', url: orgUrl('/org/me'), headers: headers(aToken) });
    expect(me.statusCode).toBe(200);
    const body = me.json() as MeBody;
    expect(body.org?.pending_invites).toEqual([
      expect.objectContaining({
        inviteId: offDomain.inviteId,
        orgName: 'Charlie Corp',
        orgSlug: 'charlie-corp',
        teamName: 'Charlie One',
        invitedBy: null,
      }),
    ]);

    const secondSignIn = await signInForChooser(USER_A);
    expect(secondSignIn.pending_invites?.map((invite) => invite.inviteId)).toEqual(
      body.org?.pending_invites.map((invite) => invite.inviteId),
    );
    expect(secondSignIn.pending_invites).toEqual([
      { inviteId: offDomain.inviteId, teamName: 'Charlie One', orgName: 'Charlie Corp', invitedBy: null },
    ]);
  });
});
