import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ConfidentialDelegationScope, Prisma, type PrismaClient } from '@prisma/client';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';
import { getAccessTokenPublicJwks, resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import {
  AGENT_GRANT_AUDIENCE_PATH,
  AGENT_GRANT_IDLE_MS,
  FIRST_PARTY_AGENT_CONNECTIONS,
  issueAgentConnectionGrant,
  renewAgentConnectionGrant,
  revokeAgentConnectionGrant,
} from '../../src/services/agent-connection-grant.service.js';
import { resolveConfidentialDelegation } from '../../src/services/confidential-delegation.service.js';
import { verifyConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';

const enabled = Boolean(process.env.DATABASE_URL);
const sourceDomain = 'app.nessie.test';
const subjectId = 'agent-grant-subject';
const orgId = 'agent-grant-org';
const teamId = 'agent-grant-team';
const product = 'nessie';
const resource = 'https://api.nessie.test/mcp';
const ledger = 'https://ledger.unlikeotherai.com';
const baseUrl = 'https://authentication.unlikeotherai.com';
const config = { org_features: { enabled: true, groups_enabled: false } };
const DAY_MS = 24 * 60 * 60 * 1000;
const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

describe.skipIf(!enabled)('agent connection grants', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  let sourcePrivateKey: KeyLike;
  let sourcePublicJwk: JWK;
  let clientDomainId: string;
  let nowSeconds: number;
  let assuranceRef: string;

  beforeAll(async () => {
    const sourcePair = await generateKeyPair('RS256', { extractable: true });
    sourcePrivateKey = sourcePair.privateKey;
    sourcePublicJwk = await exportJWK(sourcePair.publicKey);
    Object.assign(sourcePublicJwk, { kid: 'agent-grant-source', alg: 'RS256', use: 'sig' });
    const resourcePair = await generateKeyPair('RS256', { extractable: true });
    const resourcePrivateJwk = await exportJWK(resourcePair.privateKey);
    Object.assign(resourcePrivateJwk, { kid: 'agent-grant-resource', alg: 'RS256', use: 'sig' });

    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required');
    db = handle.prisma;
    cleanup = handle.cleanup;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.PUBLIC_BASE_URL = baseUrl;
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(resourcePrivateJwk);
    resetAccessTokenKeyCache();
    nowSeconds = Math.floor(Date.now() / 1000);

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`INSERT INTO users (id, email, user_key, name) VALUES
        (${subjectId}, 'agent-grant@example.com', 'agent-grant@example.com', 'Grant test'),
        ('agent-grant-owner', 'agent-owner@example.com', 'agent-owner@example.com', 'Owner')`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO organisations (id, domain, name, slug, owner_id, updated_at)
        VALUES (${orgId}, ${sourceDomain}, 'Grant test', 'agent-grant', 'agent-grant-owner', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO teams (id, org_id, name, slug, updated_at) VALUES
        (${teamId}, ${orgId}, 'Grant test', 'agent-grant', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO org_members (id, org_id, user_id, domain, role, updated_at) VALUES
        ('agent-grant-org-member', ${orgId}, ${subjectId}, ${sourceDomain}, 'member', CURRENT_TIMESTAMP),
        ('agent-grant-owner-member', ${orgId}, 'agent-grant-owner', ${sourceDomain}, 'owner', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO team_members (id, team_id, user_id, team_role, updated_at) VALUES
        ('agent-grant-team-member', ${teamId}, ${subjectId}, 'member', CURRENT_TIMESTAMP)`);
      await tx.domainRole.create({ data: { domain: sourceDomain, userId: subjectId, role: 'USER' } });
    });
    const clientDomain = await db.clientDomain.create({ data: { domain: sourceDomain, label: 'Nessie',
      status: 'active' } });
    clientDomainId = clientDomain.id;
    await db.confidentialDelegationMapping.createMany({ data: [
      { clientDomainId, product, resource, scopes: [ConfidentialDelegationScope.AGENT_CONNECTION] },
      { clientDomainId, product, resource: ledger, scopes: [ConfidentialDelegationScope.AI_INVOKE] },
    ] });
    // The approving person's live, remembered sign-in: a refresh family and its original proof.
    const familyId = `agent-grant-family-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 30 * DAY_MS);
    await db.refreshToken.create({ data: { tokenHash: randomBytes(32).toString('hex'), familyId,
      userId: subjectId, domain: sourceDomain, clientId: sourceDomain, configUrl: `https://${sourceDomain}/config`,
      orgId, teamId, expiresAt } });
    assuranceRef = randomBytes(32).toString('base64url');
    await db.sessionAssurance.create({ data: {
      referenceHash: createHash('sha256').update(assuranceRef).digest('hex'), userId: subjectId,
      credentialEpoch: 0, clientDomain: sourceDomain, orgId, teamId, familyId, method: 'independent',
      observedAt: new Date(), mfaSource: 'none', amr: ['password'], expiresAt,
    } });
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    resetAccessTokenKeyCache();
    if (cleanup) await cleanup();
  });

  const fakeConfigJwt = () => `e30.${Buffer.from(JSON.stringify({ domain: sourceDomain,
    jwks_url: `https://${sourceDomain}/.well-known/jwks.json` })).toString('base64url')}.not-checked`;

  const subjectToken = (withProof = true) => new SignJWT({ source_domain: sourceDomain, tv: 0,
    active: { orgId, teamId }, ...(withProof ? { assurance_ref: assuranceRef } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'agent-grant-source', typ: 'JWT' })
    .setIssuer(sourceDomain).setAudience(`${baseUrl}${AGENT_GRANT_AUDIENCE_PATH}`).setSubject(subjectId)
    .setIssuedAt(nowSeconds).setExpirationTime(nowSeconds + 45).setJti(randomUUID()).sign(sourcePrivateKey);

  const issue = async (requestId: string, overrides: { withProof?: boolean; connectionId?: string } = {}) =>
    issueAgentConnectionGrant({ clientDomainId, sourceDomain, configJwt: fakeConfigJwt(), config, requestId,
      connectionId: overrides.connectionId ?? 'conn-1', product, resource,
      subjectToken: await subjectToken(overrides.withProof ?? true) },
    { prisma: db, now: () => nowSeconds, fetchJwks: async () => ({ keys: [sourcePublicJwk] }) });

  const renew = (grantHandle: string, requestId: string, at: number, extra: { touch?: boolean;
    resource?: string; scope?: string } = {}) => renewAgentConnectionGrant({ grantHandle, clientDomainId,
    sourceDomain, config, requestId, touch: extra.touch ?? true, resource: extra.resource, scope: extra.scope },
  { prisma: db, now: new Date(at) });

  it('issues only from a live sign-in proof and recovers the same grant on retry', async () => {
    await expect(issue(randomUUID(), { withProof: false })).rejects.toThrow('AGENT_GRANT_REQUEST_INVALID');
    const requestId = randomUUID();
    const first = await issue(requestId);
    expect(first.created).toBe(true);
    expect(new Date(first.idleExpiresAt).getTime()).toBe(nowSeconds * 1000 + AGENT_GRANT_IDLE_MS);
    expect(await issue(requestId)).toEqual({ ...first, created: false });
    await expect(issue(requestId, { connectionId: 'conn-other' })).rejects.toThrow('AGENT_GRANT_REQUEST_CONFLICT');
  });

  it('outlives the session, slides only on touch, and lapses after 90 unused days', async () => {
    const requestId = randomUUID();
    const grant = await issue(requestId);
    // The sign-in family ends: the grant does not depend on it after issue.
    await db.refreshToken.updateMany({ where: { userId: subjectId }, data: { revokedAt: new Date() } });
    const issuedAt = nowSeconds * 1000;
    const quiet = await renew(grant.grantHandle, requestId, issuedAt + 60 * DAY_MS, { touch: false });
    expect(quiet.idleExpiresAt).toBe(grant.idleExpiresAt);
    expect(quiet.org.teams).toContain(teamId);
    const used = await renew(grant.grantHandle, requestId, issuedAt + 80 * DAY_MS);
    expect(new Date(used.idleExpiresAt).getTime()).toBe(issuedAt + 80 * DAY_MS + AGENT_GRANT_IDLE_MS);
    await expect(renew(grant.grantHandle, requestId, issuedAt + 171 * DAY_MS))
      .rejects.toThrow('AGENT_GRANT_UNAVAILABLE');
    await db.refreshToken.updateMany({ where: { userId: subjectId }, data: { revokedAt: null } });
  });

  it('honours the organisation ceiling and ends on epoch, team loss or revoke', async () => {
    const requestId = randomUUID();
    const grant = await issue(requestId);
    const issuedAt = nowSeconds * 1000;
    await db.organisation.update({ where: { id: orgId }, data: { agentConnectionMaxDays: 10 } });
    await expect(renew(grant.grantHandle, requestId, issuedAt + 11 * DAY_MS)).rejects.toThrow('AGENT_GRANT_UNAVAILABLE');
    expect((await renew(grant.grantHandle, requestId, issuedAt + DAY_MS)).expiresAt)
      .toBe(new Date(issuedAt + 10 * DAY_MS).toISOString());
    await db.organisation.update({ where: { id: orgId }, data: { agentConnectionMaxDays: null } });

    await db.teamMember.update({ where: { id: 'agent-grant-team-member' }, data: { status: 'REMOVED' } });
    await expect(renew(grant.grantHandle, requestId, issuedAt)).rejects.toThrow('AGENT_GRANT_UNAVAILABLE');
    await db.teamMember.update({ where: { id: 'agent-grant-team-member' }, data: { status: 'ACTIVE' } });

    await db.user.update({ where: { id: subjectId }, data: { tokenVersion: 1 } });
    await expect(renew(grant.grantHandle, requestId, issuedAt)).rejects.toThrow('AGENT_GRANT_UNAVAILABLE');
    await db.user.update({ where: { id: subjectId }, data: { tokenVersion: 0 } });

    expect(await revokeAgentConnectionGrant({ grantHandle: grant.grantHandle, clientDomainId, sourceDomain,
      requestId }, { prisma: db })).toEqual({ revoked: true });
    await expect(renew(grant.grantHandle, requestId, issuedAt)).rejects.toThrow('AGENT_GRANT_UNAVAILABLE');
  });

  it('mints only mapped downstream scopes and never agent.connection itself', async () => {
    const requestId = randomUUID();
    const grant = await issue(requestId);
    const at = nowSeconds * 1000;
    const renewed = await renew(grant.grantHandle, requestId, at, { resource: ledger, scope: 'ai.invoke' });
    const { payload } = await jwtVerify(renewed.resourceToken!.accessToken,
      createLocalJWKSet(await getAccessTokenPublicJwks()), { issuer: baseUrl, audience: ledger });
    expect(payload).toMatchObject({ sub: subjectId, scope: 'ai.invoke', active: { orgId, teamId },
      agent_connection: { grant_handle: grant.grantHandle, connection_id: 'conn-1' } });
    expect(payload).not.toHaveProperty('assurance_id');
    await expect(renew(grant.grantHandle, requestId, at, { resource, scope: 'agent.connection' }))
      .rejects.toThrow('AGENT_GRANT_REQUEST_INVALID');
    await expect(renew(grant.grantHandle, requestId, at, { resource: ledger, scope: 'token.provision' }))
      .rejects.toThrow('AGENT_GRANT_REQUEST_INVALID');
    await expect(resolveConfidentialDelegation({ authenticatedClientDomainId: clientDomainId, sourceDomain,
      product, resource, scope: 'agent.connection' }, { prisma: db })).rejects.toThrow();
  });

  it('stands in for a session proof only where the caller opts in, and never once revoked', async () => {
    const requestId = randomUUID();
    const grant = await issue(requestId);
    const audience = `${baseUrl}/auth/token`;
    const grantToken = (claims: Record<string, unknown> = {}) => new SignJWT({ source_domain: sourceDomain, tv: 0,
      active: { orgId, teamId }, agent_grant: grant.grantHandle, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'agent-grant-source', typ: 'JWT' })
      .setIssuer(sourceDomain).setAudience(audience).setSubject(subjectId)
      .setIssuedAt(nowSeconds).setExpirationTime(nowSeconds + 45).setJti(randomUUID()).sign(sourcePrivateKey);
    const verify = async (allowAgentGrant: boolean, claims: Record<string, unknown> = {}) =>
      verifyConfidentialSubjectToken({ subjectToken: await grantToken(claims), configJwt: fakeConfigJwt(),
        sourceDomain, audience, allowAgentGrant },
      { prisma: db, now: () => nowSeconds, fetchJwks: async () => ({ keys: [sourcePublicJwk] }) });
    const admitted = await verify(true);
    expect(admitted.verifiedAgentGrant?.id).toBe(grant.grantHandle);
    expect(admitted.verifiedAssuranceId).toBeUndefined();
    await expect(verify(false)).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    await expect(verify(true, { assurance_ref: assuranceRef })).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    await expect(verify(true, { active: { orgId, teamId: 'agent-grant-other-team' } }))
      .rejects.toThrow('INVALID_SUBJECT_TOKEN');
    await revokeAgentConnectionGrant({ grantHandle: grant.grantHandle, clientDomainId, sourceDomain, requestId },
      { prisma: db });
    await expect(verify(true)).rejects.toThrow('INVALID_SUBJECT_TOKEN');
  });

  it('needs an enabled mapping for a product that is not first-party', async () => {
    expect(FIRST_PARTY_AGENT_CONNECTIONS.nessie).toEqual({ sourceDomain: 'api.nessie.works',
      resource: 'https://api.nessie.works/mcp' });
    const requestId = randomUUID();
    const grant = await issue(requestId);
    const where = { clientDomainId_product_resource: { clientDomainId, product, resource } };
    await db.confidentialDelegationMapping.update({ where, data: { enabled: false } });
    await expect(renew(grant.grantHandle, requestId, nowSeconds * 1000)).rejects.toThrow();
    await db.confidentialDelegationMapping.update({ where, data: { enabled: true } });
    expect((await renew(grant.grantHandle, requestId, nowSeconds * 1000)).org.teams).toContain(teamId);
  });
});
