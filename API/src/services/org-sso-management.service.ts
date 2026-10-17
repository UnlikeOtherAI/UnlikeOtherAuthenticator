import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { getPublicBaseUrl, requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference, validateSessionAssurance } from './session-assurance.service.js';
import { enterpriseReadiness } from './org-sso-policy.service.js';
import { sealEnterpriseSecret } from './enterprise-secret.service.js';
import { resolveEnterpriseConfiguration, enterprisePresets } from './org-sso-configuration.service.js';

export type ManagementDb = PrismaClient | Prisma.TransactionClient;
const TEN_MINUTES = 600_000;
const CSRF_CONTEXT = 'uoa.enterprise-management.csrf.v1\0';
const csrfFor = (browser: string): string => createHmac('sha256', requireEnv('SHARED_SECRET').SHARED_SECRET)
  .update(CSRF_CONTEXT).update(browser).digest('base64url');
function failure(): never { throw new AppError('FORBIDDEN', 403, 'SSO_MANAGEMENT_REAUTH_REQUIRED'); }
export async function lockEnterpriseScope(db: ManagementDb, domain: string, orgId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`enterprise:${domain}:${orgId}`}, 0))`;
}

export async function assertManagementOwner(
  row: { userId: string; orgId: string; clientDomain: string; credentialEpoch: number;
    assuranceId: string; authenticatedAt: Date; expiresAt: Date; revokedAt: Date | null },
  db: ManagementDb,
): Promise<void> {
  const now = new Date();
  if (row.revokedAt || row.expiresAt <= now || row.authenticatedAt.getTime() + TEN_MINUTES <= now.getTime()) failure();
  const org = await db.organisation.findUnique({ where: { id: row.orgId },
    select: { ownerId: true, lifecycleStatus: true } });
  if (!org || org.ownerId !== row.userId || org.lifecycleStatus !== 'ACTIVE') failure();
  const proof = await db.sessionAssurance.findUnique({ where: { id: row.assuranceId } });
  if (!proof || proof.method !== 'independent') failure();
  await validateSessionAssurance({ id: proof.id, userId: row.userId,
    clientDomain: row.clientDomain, credentialEpoch: row.credentialEpoch,
    orgId: proof.orgId, teamId: proof.teamId, requirement: 'global_account_control' }, db);
}

export async function createManagementContinuation(input: {
  userId: string; credentialEpoch: number; clientDomain: string; orgId: string; assuranceId: string;
}) {
  const db = getAdminPrisma();
  return db.$transaction(async (tx) => {
    await lockEnterpriseScope(tx, input.clientDomain, input.orgId);
    const proof = await tx.sessionAssurance.findUnique({ where: { id: input.assuranceId } });
    if (!proof) failure();
    const expiresAt = new Date(Math.min(Date.now() + 120_000, proof.expiresAt.getTime(),
      proof.observedAt.getTime() + TEN_MINUTES));
    const row = { ...input, authenticatedAt: proof.observedAt, expiresAt, revokedAt: null };
    await assertManagementOwner(row, tx);
    const token = randomBytes(32).toString('base64url');
    await tx.orgSsoManagementSession.create({ data: { ...row, tokenHash: hashAssuranceReference(token) } });
    return { ok: true, management_url: `${getPublicBaseUrl()}/auth/organisation-access#continuation=${token}`,
      expires_at: expiresAt.toISOString() };
  });
}

export async function exchangeManagementContinuation(continuation: string) {
  return getAdminPrisma().$transaction(async (tx) => {
    const row = await tx.orgSsoManagementSession.findUnique({ where: { tokenHash: hashAssuranceReference(continuation) } });
    if (!row) failure();
    await lockEnterpriseScope(tx, row.clientDomain, row.orgId);
    await assertManagementOwner(row, tx);
    if (row.exchangedAt) failure();
    const browser = randomBytes(32).toString('base64url');
    const csrf = csrfFor(browser);
    const expiresAt = new Date(Math.min(row.authenticatedAt.getTime() + TEN_MINUTES,
      (await tx.sessionAssurance.findUniqueOrThrow({ where: { id: row.assuranceId } })).expiresAt.getTime()));
    const result = await tx.orgSsoManagementSession.updateMany({ where: { id: row.id, exchangedAt: null },
      data: { exchangedAt: new Date(), browserHash: hashAssuranceReference(browser),
        csrfHash: hashAssuranceReference(csrf), expiresAt } });
    if (result.count !== 1) failure();
    return { browser: `${row.id}.${browser}`, csrf, expiresAt, orgId: row.orgId };
  });
}

export async function managementSession(cookie: string | undefined, csrf?: string, mutation = false,
  db: ManagementDb = getAdminPrisma()) {
  const [id, browser, extra] = (cookie ?? '').split('.');
  if (!id || !browser || extra) failure();
  const row = await db.orgSsoManagementSession.findUnique({ where: { id } });
  if (!row?.exchangedAt || !row.browserHash || row.browserHash !== hashAssuranceReference(browser)) failure();
  if (mutation) {
    const expected = Buffer.from(csrfFor(browser));
    const provided = Buffer.from(csrf ?? '');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) failure();
    await lockEnterpriseScope(db, row.clientDomain, row.orgId);
  }
  await assertManagementOwner(row, db);
  return { ...row, csrf: csrfFor(browser) };
}

export function publicConnection(row: {
  id: string; preset: string; protocol: string; displayName: string; status: string; revision: number;
  configuration: Prisma.JsonValue; encryptedSecret: string | null; testedRevision: number | null;
  lastTestCode: string | null; lastTestAt: Date | null;
}) {
  const base = `${getPublicBaseUrl()}/sso`;
  return { id: row.id, preset: row.preset, protocol: row.protocol, display_name: row.displayName,
    status: row.status, revision: row.revision, configuration: row.configuration,
    secret_configured: Boolean(row.encryptedSecret), tested_revision: row.testedRevision,
    last_test: row.lastTestAt ? { status: row.lastTestCode === 'PASSED' ? 'passed' : 'failed',
      code: row.lastTestCode, at: row.lastTestAt.toISOString() } : null,
    callback_url: `${base}/oidc/${row.id}/callback`, sp_entity_id: `${base}/saml/${row.id}`,
    acs_url: `${base}/saml/${row.id}/acs`, metadata_url: `${base}/saml/${row.id}/metadata` };
}

export async function managementView(session: Awaited<ReturnType<typeof managementSession>>,
  db: ManagementDb = getAdminPrisma()) {
  const where = { clientDomain: session.clientDomain, orgId: session.orgId };
  const [org, policy, connections, domains, readiness] = await Promise.all([
    db.organisation.findUniqueOrThrow({ where: { id: session.orgId }, select: { id: true, name: true } }),
    db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: where } }),
    db.orgSsoConnection.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.organisationEmailDomain.findMany({ where, select: { id: true, emailDomain: true, status: true,
      verifiedAt: true, checkedAt: true, challengeExpiresAt: true } }), enterpriseReadiness(session.clientDomain, db as PrismaClient),
  ]);
  return { ok: true, version: 1, org, client_domain: session.clientDomain, csrf_token: session.csrf,
    expires_at: session.expiresAt.toISOString(), capabilities: { manage_sso: true },
    policy: { revision: policy?.revision ?? 0, enforcement: policy?.enforcement ?? 'off',
      session_max_age_seconds: policy?.sessionMaxAgeSeconds ?? 28800, reauth_mode: policy?.reauthMode ?? 'detect_only' },
    connections: connections.map(publicConnection), domains: domains.map((d) => ({ id: d.id,
      email_domain: d.emailDomain, status: d.status, verified_at: d.verifiedAt, checked_at: d.checkedAt,
      challenge_expires_at: d.challengeExpiresAt.toISOString() })),
    readiness, presets: enterprisePresets, scim: { enabled: false } };
}

export async function saveEnterpriseConnection(session: Awaited<ReturnType<typeof managementSession>>,
  input: { preset: string; protocol: 'oidc' | 'saml'; display_name: string;
    configuration: Record<string, unknown>; secret?: string; revision?: number }, id: string | undefined,
  db: ManagementDb) {
  const isEmptyDraft = !id && Object.keys(input.configuration).length === 0;
  if (!enterprisePresets.some((p) => p.id === input.preset && (p.protocols as readonly string[]).includes(input.protocol))) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_PRESET_INVALID');
  }
  const configuration = isEmptyDraft ? {} : await resolveEnterpriseConfiguration(input.preset, input.protocol, input.configuration);
  const where = { clientDomain: session.clientDomain, orgId: session.orgId };
  await db.orgSsoPolicy.upsert({ where: { clientDomain_orgId: where }, create: where, update: {} });
  const prior = id ? await db.orgSsoConnection.findFirst({ where: { id, ...where } }) : null;
  if (id && (!prior || prior.revision !== input.revision)) throw new AppError('BAD_REQUEST', 409, 'SSO_REVISION_CONFLICT');
  if (prior && prior.status !== 'draft' && prior.status !== 'testing') {
    // Identity-affecting config is locked after activation, including while disabled.
    throw new AppError('FORBIDDEN', 403, 'SSO_IDENTITY_MIGRATION_REQUIRED');
  }
  if (!prior && await db.orgSsoConnection.count({ where }) >= 10) throw new AppError('BAD_REQUEST', 409, 'SSO_CONNECTION_LIMIT');
  const connectionId = prior?.id ?? randomBytes(20).toString('hex');
  const encryptedSecret = input.secret === undefined ? prior?.encryptedSecret ?? null :
    sealEnterpriseSecret(input.secret, `connection:${connectionId}`);
  const data = { ...where, preset: input.preset, protocol: input.protocol, displayName: input.display_name,
    configuration: configuration as Prisma.InputJsonValue, encryptedSecret, testedRevision: null,
    lastTestCode: null, lastTestAt: null };
  const row = prior ? await db.orgSsoConnection.update({ where: { id: prior.id },
    data: { ...data, revision: { increment: 1 } } }) : await db.orgSsoConnection.create({ data: { id: connectionId, ...data } });
  await db.orgAuditLog.create({ data: { orgId: session.orgId, actorUserId: session.userId,
    action: 'sso.connection_saved', targetType: 'organisation', targetId: connectionId,
    metadata: { revision: row.revision, protocol: row.protocol } } });
  return { ok: true, connection: publicConnection(row) };
}
