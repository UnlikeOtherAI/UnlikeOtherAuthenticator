import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose } from '@prisma/client';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateConfigFields } from '../../src/services/config.service.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { issueSessionAssurance, validateSessionAssurance } from '../../src/services/session-assurance.service.js';
import { exchangeTeamSessionForTokens } from '../../src/services/team-session-token.service.js';
import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('team-session grant issues another team’s session from the same sign-in', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const saved = Object.fromEntries(['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SHARED_SECRET',
    'AUTH_SERVICE_IDENTIFIER', 'ENTERPRISE_SSO_CUSTODY_PROVIDER', 'ENTERPRISE_SSO_KEYRING']
    .map(key => [key, process.env[key]]));
  const sharedSecret = 'team-session-test-secret-with-enough-length';

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL is required for team-session coverage');
    handle = created;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: {
      test: randomBytes(32).toString('base64'),
    } });
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await handle?.cleanup();
  });

  async function fixture(options: { method?: 'independent' | 'sso'; withProof?: boolean;
    proofLifetimeMs?: number } = {}) {
    const method = options.method ?? 'independent';
    const db = handle.prisma;
    const domain = `team-session-${randomUUID()}.example.com`;
    const configUrl = `https://${domain}/config`;
    const config = validateConfigFields(baseClientConfigPayload({ domain,
      redirect_urls: [`https://${domain}/callback`], '2fa_enabled': true,
      org_features: { enabled: true, user_needs_team: false },
      login_flow: { email_code_enabled: false, team_selection: 'off' } }));
    const clientId = await seedDomainSecret(db, domain);
    const client = await db.clientDomain.findUniqueOrThrow({ where: { domain } });
    await db.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 1 } });
    const service = await db.billingService.create({
      data: { identifier: `team-session-${randomUUID()}`, name: 'Team session product' }, select: { id: true } });
    await db.billingAppKey.create({ data: { serviceId: service.id, purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      name: 'Lifecycle', keyPrefix: `test_${randomUUID().slice(0, 8)}`,
      secretDigest: createHash('sha256').update(randomUUID()).digest('hex'), actorIssuer: `https://${domain}`,
      actorAudience: 'https://authentication.example/billing/v1/customer-statement', actorKeyId: 'test-key',
      actorPublicJwk: {}, checkoutReturnOrigins: [`https://${domain}`] } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    const owner = await db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    const scope = async (label: string, orgId?: string) => {
      const org = orgId ? { id: orgId } : await db.organisation.create({ data: { domain: `${label}-${randomUUID()}.example`,
        ownerId: owner.id, name: label, slug: `${label}-${randomUUID()}` } });
      const team = await db.team.create({ data: { orgId: org.id, name: label, slug: `${label}-${randomUUID()}`,
        isDefault: !orgId } });
      if (!orgId) {
        await db.orgMember.createMany({ data: [{ orgId: org.id, userId: owner.id, role: 'owner' },
          { orgId: org.id, userId: user.id, role: 'member' }] });
      }
      await db.teamMember.createMany({ data: [{ teamId: team.id, userId: owner.id, teamRole: 'owner' },
        { teamId: team.id, userId: user.id, teamRole: 'member' }] });
      return { orgId: org.id, teamId: team.id };
    };
    const source = await scope('source');
    const sibling = await scope('sibling', source.orgId);
    const other = await scope('other');
    const policy = await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: source.orgId,
      arrangementEnabled: true, enforcement: method === 'sso' ? 'required_for_all_members' : 'off' } });
    const connection = method === 'sso' ? await db.orgSsoConnection.create({ data: {
      clientDomain: domain, orgId: source.orgId, protocol: 'oidc', preset: 'other_oidc', displayName: 'Test',
      configuration: {}, status: 'active' } }) : null;
    const identity = connection ? await db.externalIdentity.create({ data: { connectionId: connection.id,
      clientDomain: domain, orgId: source.orgId, userId: user.id, issuer: 'https://idp.example.com',
      tenant: 'customer', subject: randomUUID(), identityScope: 'product', linkedVia: 'independent_session' } }) : null;
    const familyId = randomUUID();
    const refresh = await issueRefreshToken({ familyId, userId: user.id, domain, clientId, configUrl,
      ...source, twoFaCompleted: false }, { prisma: db, refreshTokenTtlSeconds: 30 * 86_400, sharedSecret });
    const expiresAt = new Date(Date.now() + (options.proofLifetimeMs ?? 7 * 86_400_000));
    const original = options.withProof === false ? null : await db.$transaction(async tx => {
      const issued = await issueSessionAssurance({ familyId, userId: user.id, clientDomain: domain,
        credentialEpoch: 0, ...source, method, observedAt: new Date(Date.now() - 60_000), authenticatedAt: null,
        mfaSource: method === 'sso' ? 'upstream_claimed' : 'none', amr: [method === 'sso' ? 'idp' : 'pwd'],
        policyGeneration: policy.generation, connectionId: connection?.id, externalIdentityId: identity?.id,
        connectionRevision: connection?.revision, connectionGeneration: connection?.generation, expiresAt }, tx);
      await tx.refreshToken.update({ where: { id: refresh.refreshTokenId }, data: { assuranceId: issued.assurance.id } });
      return issued.assurance;
    });
    const open = (target: { orgId: string; teamId: string }, refreshToken = refresh.refreshToken) =>
      exchangeTeamSessionForTokens({ authenticatedClientDomainId: client.id, clientId, config, configUrl,
        organizationId: target.orgId, teamId: target.teamId, refreshToken },
      { prisma: db, adminPrisma: db, sharedSecret });
    const renew = (refreshToken: string) => exchangeRefreshTokenForTokens({ authenticatedClientDomainId: client.id,
      clientId, config, configUrl, refreshToken }, { prisma: db, adminPrisma: db, sharedSecret });
    return { user, source, sibling, other, refresh, original, open, renew, domain };
  }

  const sourceUntouched = async (seeded: Awaited<ReturnType<typeof fixture>>) => {
    expect(await handle.prisma.refreshToken.findUniqueOrThrow({ where: { id: seeded.refresh.refreshTokenId },
      select: { revokedAt: true, replacedByTokenId: true, orgId: true, teamId: true, assuranceId: true } }))
      .toEqual({ revokedAt: null, replacedByTokenId: null, ...seeded.source, assuranceId: seeded.original?.id ?? null });
  };

  it('opens another organisation’s team without a browser and leaves the source session as it was', async () => {
    const seeded = await fixture();
    const issued = await seeded.open(seeded.other);
    const claims = decodeJwt(issued.accessToken) as { active?: { orgId: string; teamId: string }; assurance_id?: string };
    expect(claims.active).toMatchObject(seeded.other);
    expect(issued.assuranceRef).toEqual(expect.any(String));
    const derived = await handle.prisma.sessionAssurance.findUniqueOrThrow({ where: { id: claims.assurance_id! } });
    expect(derived).toMatchObject({ derivedFromId: seeded.original!.id, parentId: null, method: 'independent',
      ...seeded.other, observedAt: seeded.original!.observedAt });
    expect(derived.expiresAt.getTime()).toBeLessThanOrEqual(seeded.original!.expiresAt.getTime());
    expect(Date.parse(issued.assuranceExpiresAt!)).toBe(derived.expiresAt.getTime());
    await sourceUntouched(seeded);

    // The new family renews in its own scope with the same proof and deadline; the source still renews too.
    const renewed = await seeded.renew(issued.refreshToken);
    expect(renewed.assuranceRef).toBe(issued.assuranceRef);
    expect((decodeJwt(renewed.accessToken) as { active?: unknown }).active).toMatchObject(seeded.other);
    // Going back is the same call from the derived session; its proof still points at the original.
    const back = await seeded.open(seeded.source, renewed.refreshToken);
    const backProof = await handle.prisma.sessionAssurance.findUniqueOrThrow({
      where: { id: (decodeJwt(back.accessToken) as { assurance_id: string }).assurance_id } });
    expect(backProof.derivedFromId).toBe(seeded.original!.id);

    // Ending the original sign-in ends every session derived from it.
    await handle.prisma.sessionAssurance.update({ where: { id: seeded.original!.id }, data: { revokedAt: new Date() } });
    await expect(validateSessionAssurance({ id: derived.id, userId: seeded.user.id, clientDomain: seeded.domain,
      credentialEpoch: 0, ...seeded.other }, handle.prisma)).rejects.toThrow('INVALID_SESSION_ASSURANCE');
    await expect(seeded.renew(renewed.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('keeps an enterprise SSO sign-in inside its own organisation', async () => {
    const seeded = await fixture({ method: 'sso' });
    await expect(seeded.open(seeded.other)).rejects.toMatchObject({ statusCode: 403, message: 'INTERACTION_REQUIRED' });
    const sibling = await seeded.open(seeded.sibling);
    expect((decodeJwt(sibling.accessToken) as { active?: unknown }).active).toMatchObject(seeded.sibling);
    await sourceUntouched(seeded);
  });

  it('refuses what the original sign-in cannot open, changing nothing', async () => {
    const seeded = await fixture();
    const before = await handle.prisma.refreshToken.count({ where: { userId: seeded.user.id } });
    await handle.prisma.teamMember.deleteMany({ where: { teamId: seeded.other.teamId, userId: seeded.user.id } });
    await expect(seeded.open(seeded.other)).rejects.toMatchObject({ statusCode: 403, message: 'TEAM_NOT_AVAILABLE' });
    await handle.prisma.organisation.update({ where: { id: seeded.sibling.orgId }, data: { twoFaPolicy: 'REQUIRED' } });
    await expect(seeded.open(seeded.sibling)).rejects.toMatchObject({ statusCode: 403, message: 'INTERACTION_REQUIRED' });
    await expect(seeded.open(seeded.source)).rejects.toMatchObject({ statusCode: 400 });
    expect(await handle.prisma.refreshToken.count({ where: { userId: seeded.user.id } })).toBe(before);
    expect(await handle.prisma.sessionAssurance.count({ where: { userId: seeded.user.id } })).toBe(1);
    await sourceUntouched(seeded);
  });

  it('sends a proof-free, ending or ended sign-in back to the browser', async () => {
    const legacy = await fixture({ withProof: false });
    await expect(legacy.open(legacy.other)).rejects.toMatchObject({ statusCode: 403, message: 'INTERACTION_REQUIRED' });
    const ending = await fixture({ proofLifetimeMs: 2 * 60_000 });
    await expect(ending.open(ending.other)).rejects.toMatchObject({ statusCode: 403, message: 'INTERACTION_REQUIRED' });
    const ended = await fixture();
    await handle.prisma.refreshToken.update({ where: { id: ended.refresh.refreshTokenId }, data: { revokedAt: new Date() } });
    await expect(ended.open(ended.other)).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_REFRESH_TOKEN' });
    await expect(ended.open(ended.other, 'not-a-refresh-token')).rejects.toMatchObject({ statusCode: 401 });
  });
});
