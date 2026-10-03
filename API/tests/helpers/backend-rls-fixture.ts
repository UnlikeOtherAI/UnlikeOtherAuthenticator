import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { createRlsTestDb } from './test-db.js';
import { clearOrgTestDatabase, createSignedConfigJwt, createTestUser } from './org-user-endpoints-helper.js';
export const ATTACKER_DOMAIN = 'rls-attacker.example.com';
const ATTACKER_CONFIG_URL = `https://${ATTACKER_DOMAIN}/auth-config`;
export const VICTIM_DOMAIN = 'rls-victim.example.com';
const VICTIM_CONFIG_URL = `https://${VICTIM_DOMAIN}/auth-config`;

export function useBackendRlsFixture() {
  const state = { handle: null as Awaited<ReturnType<typeof createRlsTestDb>> };

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAdminUrl = process.env.DATABASE_ADMIN_URL;

  beforeAll(async () => {
    state.handle = await createRlsTestDb();
    if (!state.handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    // The app now runs as the real RLS role; only the test's own seeding uses
    // `state.handle.prisma` (superuser).
    process.env.DATABASE_URL = state.handle.appDatabaseUrl;
    process.env.DATABASE_ADMIN_URL = state.handle.adminDatabaseUrl;
  });

  afterAll(async () => {
    await disconnectPrisma();
    process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalAdminUrl === undefined) delete process.env.DATABASE_ADMIN_URL;
    else process.env.DATABASE_ADMIN_URL = originalAdminUrl;
    if (state.handle) await state.handle.cleanup();
  });

  beforeEach(async () => {
    if (!state.handle) return;
    await state.handle.prisma.orgAuditLog.deleteMany();
    await state.handle.prisma.domainRole.deleteMany();
    await state.handle.prisma.accessRequest.deleteMany();
    await clearOrgTestDatabase(state.handle);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Serve each domain its own signed config. The attacker's config is where the
   * cross-tenant probe lives: it is signed by the attacker, so the attacker
   * chooses every value in it — including ids that belong to another tenant.
   */
  async function stubConfigs(opts?: {
    attackerAccessRequests?: Record<string, unknown>;
    victimAccessRequests?: Record<string, unknown>;
    allowUserCreateOrg?: boolean;
  }): Promise<void> {
    const attackerJwt = await createSignedConfigJwt(
      process.env.SHARED_SECRET!,
      {
        backend_org_management: true,
        ...(opts?.allowUserCreateOrg === undefined
          ? {}
          : { allow_user_create_org: opts.allowUserCreateOrg }),
      },
      ATTACKER_DOMAIN,
      opts?.attackerAccessRequests,
    );
    const victimJwt = await createSignedConfigJwt(
      process.env.SHARED_SECRET!,
      { backend_org_management: true },
      VICTIM_DOMAIN,
      opts?.victimAccessRequests,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes(VICTIM_DOMAIN)) return new Response(victimJwt, { status: 200 });
        return new Response(attackerJwt, { status: 200 });
      }),
    );
  }

  function url(path: string, domain = ATTACKER_DOMAIN): string {
    const configUrl = domain === VICTIM_DOMAIN ? VICTIM_CONFIG_URL : ATTACKER_CONFIG_URL;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`;
  }

  /** Seed an org + default team + owner directly, bypassing the API. */
  async function seedOrg(params: {
    domain: string;
    name: string;
    slug: string;
    ownerEmail: string;
  }): Promise<{ orgId: string; teamId: string; ownerId: string }> {
    const owner = await createTestUser(state.handle!, params.ownerEmail);
    const org = await state.handle!.prisma.organisation.create({
      data: {
        domain: params.domain,
        name: params.name,
        slug: params.slug,
        ownerId: owner.id,
      },
      select: { id: true },
    });
    const team = await state.handle!.prisma.team.create({
      data: { orgId: org.id, name: 'General', slug: 'general', isDefault: true },
      select: { id: true },
    });
    await state.handle!.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    await state.handle!.prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id } });
    // Login writes this row (`ensureDomainRoleForUser`); backend org-create now
    // requires it as proof the named owner belongs to the calling domain.
    await state.handle!.prisma.domainRole.create({
      data: { domain: params.domain, userId: owner.id },
    });
    return { orgId: org.id, teamId: team.id, ownerId: owner.id };
  }

  return { state, stubConfigs, url, seedOrg };
}
