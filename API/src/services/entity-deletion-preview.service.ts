import { Prisma, type PrismaClient, type LifecycleScope, type IdentityDeletionMode } from '@prisma/client';
import { createHash } from 'node:crypto';
import { getEnv, getAdminAuthDomain } from '../config/env.js';
import { lifecycleTarget } from './internal-admin-lifecycle.service.js';

type Counter = { count(args: { where: Record<string, unknown> }): Promise<number> };
export async function activeBillingBlockers(tx: PrismaClient, scope: LifecycleScope, id: string) {
  const modelName = scope === 'USER' ? 'User' : scope === 'TEAM' ? 'Team' : 'Organisation';
  const blockers: string[] = [];
  for (const model of Prisma.dmmf.datamodel.models.filter(m => m.name.startsWith('Billing') && /Checkout|Subscription|AutoTopUpAttempt|CancellationIntent|OrgResponsibility/.test(m.name))) {
    const keys = model.fields.filter(f => f.kind === 'object' && f.type === modelName).flatMap(f => f.relationFromFields ?? []);
    const state = model.fields.find(f => ['status', 'state', 'active'].includes(f.name));
    if (!keys.length || !state) continue;
    const terminal = state.kind === 'enum' ? (Prisma.dmmf.datamodel.enums.find(e => e.name === state.type)?.values ?? [])
      .filter(v => ['COMPLETE', 'COMPLETED', 'EXPIRED', 'ABANDONED', 'CANCELED', 'CANCELLED', 'FAILED'].includes(v.name)).map(v => v.name)
      : ['canceled', 'incomplete_expired', 'complete', 'expired'];
    const where = { OR: keys.map(key => ({ [key]: id })), [state.name]: state.name === 'active' ? true : { notIn: terminal } };
    const delegate = (tx as unknown as Record<string, Counter>)[model.name[0].toLowerCase() + model.name.slice(1)];
    if (await delegate.count({ where })) blockers.push(`Close or transfer active ${model.name} operations before deletion.`);
  }
  const where = scope === 'USER' ? { autoTopUpConsentedByUserId: id } : scope === 'TEAM' ? { teamId: id } : { orgId: id };
  if (await tx.billingCreditAccount.count({ where: { ...where, autoTopUpState: { not: 'DISABLED' } } })) blockers.push('Disable automatic top-up before deletion.');
  return blockers;
}
export type RetainedEvidence = { model: string; count: number; reason: string; scope?: LifecycleScope; targetId?: string };
export async function retainedEvidence(tx: PrismaClient, scope: LifecycleScope, id: string): Promise<RetainedEvidence[]> {
  const referencedModel = scope === 'USER' ? 'User' : scope === 'TEAM' ? 'Team' : 'Organisation';
  const models = Prisma.dmmf.datamodel.models.filter(model => model.name.startsWith('Billing') ||
    ['AgreementSignature', 'SignatureClaimIntent'].includes(model.name));
  const evidence: RetainedEvidence[] = [];
  const queries: Prisma.Sql[] = [];
  const identity = scope === 'USER' ? await tx.user.findUnique({ where: { id }, select: { email: true } }) : null;
  for (const model of models) {
    const keys = model.fields.filter(f => f.kind === 'object' && f.type === referencedModel && f.relationOnDelete === 'Restrict')
      .flatMap(f => f.relationFromFields ?? []);
    const scalarKeys = scope === 'USER' && !['BillingAppKey', 'BillingTariffAssignment'].includes(model.name) ? model.fields.filter(f => f.kind === 'scalar' && /^(createdByUserId|actorUserId)$/.test(f.name)).map(f => f.name) : [];
    const emailKeys = scope === 'USER' && !['BillingAppKey', 'BillingTariffAssignment'].includes(model.name) ? model.fields.filter(f => f.kind === 'scalar' && /^(createdByEmail|actorEmail|publishedByEmail)$/.test(f.name)).map(f => f.name) : [];
    if (!keys.length && !scalarKeys.length && !emailKeys.length) continue;
    const table = Prisma.raw(`"${model.dbName ?? model.name}"`);
    const columns = [...new Set([...keys, ...scalarKeys])].map(key => Prisma.raw(`"${model.fields.find(f => f.name === key)?.dbName ?? key}"`));
    const conditions = columns.map(column => Prisma.sql`${column}=${id}`);
    if (identity?.email) for (const key of emailKeys) conditions.push(Prisma.sql`lower(${Prisma.raw(`"${model.fields.find(f => f.name === key)?.dbName ?? key}"`)})=lower(${identity.email})`);
    if (conditions.length) queries.push(Prisma.sql`SELECT ${model.name}::text AS model, COUNT(*)::int AS count FROM ${table} WHERE ${Prisma.join(conditions, ' OR ')}`);
  }
  if (scope === 'USER') {
    queries.push(Prisma.sql`SELECT 'SignatureAuditEvent'::text AS model, COUNT(*)::int AS count FROM signature_audit_events WHERE actor_user_id=${id} OR target_id=${id} OR metadata::text LIKE ${`%${id}%`} OR (${Boolean(identity?.email)} AND lower(to_jsonb(signature_audit_events)::text) LIKE ${`%${identity?.email?.toLowerCase() ?? ''}%`})`);
    if (identity?.email) {
      queries.push(Prisma.sql`SELECT 'SignatureRevocation'::text AS model, COUNT(*)::int AS count FROM signature_revocations WHERE lower(actor_email)=lower(${identity.email})`);
      queries.push(Prisma.sql`SELECT 'AgreementVersion'::text AS model, COUNT(*)::int AS count FROM agreement_versions WHERE lower(published_by_email)=lower(${identity.email})`);
    }
  }
  const counts = queries.length ? await tx.$queryRaw<{ model: string; count: number }[]>(Prisma.join(queries, ' UNION ALL ')) : [];
  for (const { model, count } of counts) {
    if (count) evidence.push({ model, count, scope, targetId: id, reason: model.startsWith('Billing')
      ? 'Restricted commercial history; active collection must be settled separately.'
      : 'Restricted signing evidence under its existing retention policy.' });
  }
  return evidence;
}

export type DeletionPreview = {
  scope: LifecycleScope; targetId: string; effectiveScope: LifecycleScope; effectiveTargetId: string;
  mode: IdentityDeletionMode; name: string; teamIds: string[]; organisationId: string | null;
  deletesEmptyOrganisation: boolean; candidates: { id: string; eligible: boolean; reasons: string[] }[];
  retainedEvidence: RetainedEvidence[]; participants: { clientDomainId: string; domain: string }[];
  blockers: string[]; confirmation: string; digest: string;
};

export async function orphanEligibility(tx: PrismaClient, userId: string, orgId: string | null, teamIds: string[], deleteOrg: boolean, committed = false) {
  const reasons: string[] = [];
  const identity = await tx.user.findUnique({ where: { id: userId }, select: { lifecycleStatus: true } });
  if (!identity || (identity.lifecycleStatus !== 'DELETING' || !committed) && ['DELETING', 'DELETED'].includes(identity.lifecycleStatus)) reasons.push('Account already has a terminal lifecycle');
  if (await tx.teamMember.count({ where: { userId, teamId: { notIn: teamIds } } })) reasons.push('Other team membership');
  if (await tx.orgMember.count({ where: { userId, ...(orgId ? { orgId: { not: orgId } } : {}) } })) reasons.push('Other organisation membership');
  if (await tx.organisation.count({ where: { ownerId: userId, ...(deleteOrg && orgId ? { id: { not: orgId } } : {}) } })) reasons.push('Organisation ownership');
  const nativeDomain = getEnv().MCP_OAUTH_DOMAIN;
  if (nativeDomain && await tx.domainRole.count({ where: { userId, domain: nativeDomain } })) reasons.push('Standalone native account');
  if (await tx.domainRole.count({ where: { userId, domain: getAdminAuthDomain(), role: 'SUPERUSER' } })) reasons.push('Platform administrator');
  if (await tx.userSetting.count({ where: { userId } })) reasons.push('Personal settings');
  if (await tx.billingServiceAccess.count({ where: { userId, teamId: { notIn: teamIds } } })) reasons.push('Other product access dependency');
  const scopeDomain = orgId ? (await tx.organisation.findUnique({ where: { id: orgId }, select: { domain: true } }))?.domain : undefined;
  if (await tx.domainRole.count({ where: { userId, ...(scopeDomain ? { domain: { not: scopeDomain } } : {}) } })) reasons.push('Other product identity association');
  if (await tx.refreshToken.count({ where: { userId, OR: [{ orgId: null }, { orgId: { not: orgId ?? '' } }] } })) reasons.push('Standalone or other product session history');
  if (await tx.loginLog.count({ where: { userId, ...(scopeDomain ? { domain: { not: scopeDomain } } : {}) } })) reasons.push('Other product authentication history');
  if ((await retainedEvidence(tx, 'USER', userId)).length) reasons.push('Protected billing or signing dependencies');
  return { id: userId, eligible: reasons.length === 0, reasons };
}

export async function previewEntityDeletion(tx: PrismaClient, scope: LifecycleScope, id: string, mode: IdentityDeletionMode): Promise<DeletionPreview> {
  const row = await lifecycleTarget(tx, scope, id);
  let effectiveScope = scope, effectiveTargetId = id;
  let orgId: string | null = scope === 'ORGANISATION' ? id : null;
  let teamIds: string[] = [];
  let deletesEmptyOrganisation = false;
  if (scope === 'TEAM') {
    const team = await tx.team.findUniqueOrThrow({ where: { id } });
    orgId = team.orgId;
    const others = await tx.team.count({ where: { orgId, id: { not: id }, lifecycleStatus: { not: 'DELETED' } } });
    if (others === 0) { effectiveScope = 'ORGANISATION'; effectiveTargetId = orgId; deletesEmptyOrganisation = true; }
    else teamIds = [id];
  }
  if (effectiveScope === 'ORGANISATION') teamIds = (await tx.team.findMany({ where: { orgId: effectiveTargetId }, orderBy: { id: 'asc' } })).map(t => t.id);
  const teamCandidates = scope === 'USER' ? [] : (await tx.teamMember.findMany({ where: { teamId: { in: teamIds } }, select: { userId: true } })).map(m => m.userId);
  const orgCandidates = effectiveScope === 'ORGANISATION' ? (await tx.orgMember.findMany({ where: { orgId: effectiveTargetId }, select: { userId: true } })).map(m => m.userId) : [];
  const owner = effectiveScope === 'ORGANISATION' ? (await tx.organisation.findUniqueOrThrow({ where: { id: effectiveTargetId }, select: { ownerId: true } })).ownerId : null;
  const candidateIds = scope === 'USER' ? [id] : [...new Set([...teamCandidates, ...orgCandidates, ...(owner ? [owner] : [])])].sort();
  const candidates = scope === 'USER' ? [] : await Promise.all(candidateIds.map(userId => orphanEligibility(tx, userId, orgId, teamIds, effectiveScope === 'ORGANISATION')));
  const blockers: string[] = [];
  if (orgId && await tx.team.count({ where: { orgId, lifecycleStatus: 'DELETING', id: { notIn: teamIds } } })) blockers.push('Finish the existing deletion in this organisation before confirming another container deletion.');
  if (effectiveScope === 'ORGANISATION' && await tx.team.count({ where: { orgId: effectiveTargetId, lifecycleStatus: 'DELETING' } })) blockers.push('Finish the existing team deletion before confirming organisation deletion.');
  if (scope === 'TEAM' && (await tx.organisation.findUniqueOrThrow({ where: { id: orgId ?? '' } })).lifecycleStatus === 'DELETING') blockers.push('The organisation already has a deletion in progress.');
  blockers.push(...await activeBillingBlockers(tx, effectiveScope, effectiveTargetId));
  for (const candidate of candidates.filter(c => c.eligible)) blockers.push(...await activeBillingBlockers(tx, 'USER', candidate.id));
  if (scope === 'USER' && await tx.organisation.count({ where: { ownerId: id, lifecycleStatus: { not: 'DELETED' } } })) blockers.push('Transfer ownership of every retained organisation before deleting this account.');
  const evidence = await retainedEvidence(tx, effectiveScope, effectiveTargetId);
  for (const teamId of teamIds.filter(teamId => effectiveScope !== 'TEAM' || teamId !== effectiveTargetId)) evidence.push(...await retainedEvidence(tx, 'TEAM', teamId));
  for (const userId of candidateIds.filter(userId => effectiveScope !== 'USER' || userId !== effectiveTargetId)) evidence.push(...await retainedEvidence(tx, 'USER', userId));
  // Live financial capabilities are not inert history. They must be closed before the job can finish.
  const billingWhere = orgId ? { orgId, ...(effectiveScope === 'TEAM' ? { teamId: id } : {}) } : { userId: id };
  if (scope !== 'USER' && await tx.billingStripeSubscription.count({ where: { ...billingWhere, status: { notIn: ['canceled', 'incomplete_expired'] } } })) blockers.push('Cancel active Stripe subscriptions before confirming deletion.');
  if (scope !== 'USER' && await tx.billingCreditAccount.count({ where: { ...billingWhere, autoTopUpState: { not: 'DISABLED' } } })) blockers.push('Disable automatic top-up before confirming deletion.');
  const domainSet = new Set<string>();
  if (scope === 'USER') {
    const identity = await tx.user.findUniqueOrThrow({ where: { id }, select: { domain: true } });
    if (identity.domain) domainSet.add(identity.domain);
    for (const membership of await tx.orgMember.findMany({ where: { userId: id }, select: { org: { select: { domain: true } } } })) domainSet.add(membership.org.domain);
    for (const role of await tx.domainRole.findMany({ where: { userId: id } })) domainSet.add(role.domain);
    for (const log of await tx.loginLog.findMany({ where: { userId: id }, distinct: ['domain'], select: { domain: true } })) domainSet.add(log.domain);
    for (const session of await tx.refreshToken.findMany({ where: { userId: id }, distinct: ['domain'], select: { domain: true } })) domainSet.add(session.domain);
    for (const signature of await tx.agreementSignature.findMany({ where: { userId: id }, distinct: ['domain'], select: { domain: true } })) domainSet.add(signature.domain);
  } else {
    const org = await tx.organisation.findUniqueOrThrow({ where: { id: orgId ?? '' } });
    domainSet.add(org.domain);
    const sessions = await tx.refreshToken.findMany({ where: effectiveScope === 'TEAM' ? { teamId: id } : { orgId: orgId ?? '' }, select: { domain: true } });
    for (const session of sessions) domainSet.add(session.domain);
    for (const candidate of candidates.filter(c => c.eligible)) {
      for (const role of await tx.domainRole.findMany({ where: { userId: candidate.id }, select: { domain: true } })) domainSet.add(role.domain);
      for (const log of await tx.loginLog.findMany({ where: { userId: candidate.id }, distinct: ['domain'], select: { domain: true } })) domainSet.add(log.domain);
    }
  }
  domainSet.delete(getAdminAuthDomain());
  const nativeDomain = getEnv().MCP_OAUTH_DOMAIN;
  if (nativeDomain) domainSet.delete(nativeDomain);
  const participants: DeletionPreview['participants'] = [];
  if (teamIds.length || scope === 'USER') {
    const accesses = await tx.billingServiceAccess.findMany({ where: scope === 'USER' ? { userId: id } : { teamId: { in: teamIds } }, select: { appKey: { select: { actorIssuer: true } } } });
    for (const access of accesses) {
      try {
        const issuer = new URL(access.appKey.actorIssuer);
        if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/' || issuer.port) throw new Error('Unsupported authority');
        domainSet.add(issuer.hostname.toLowerCase());
      } catch { blockers.push('Product access history has no exact registered HTTPS issuer authority.'); }
    }
  }
  for (const domain of [...domainSet].sort()) {
    const client = await tx.clientDomain.findUnique({ where: { domain }, select: { id: true } });
    if (client) participants.push({ clientDomainId: client.id, domain });
    else blockers.push(`Product inventory has no registered authority for ${domain}.`);
  }
  const base = { scope, targetId: id, effectiveScope, effectiveTargetId, mode, name: row.name ?? 'Deleted user', teamIds,
    organisationId: orgId, deletesEmptyOrganisation, candidates, retainedEvidence: evidence, participants, blockers,
    confirmation: `DELETE ${id}` };
  return { ...base, digest: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}
