import { Prisma } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { boundedEnterpriseTxt, suspendEnterpriseDomainLinks } from './org-email-domain.service.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { lockEnterpriseOutbox } from './org-sso-revocation.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { lockEnterpriseScope } from './org-sso-management.service.js';

/** Bounded transient cleanup. Stable external links, erasure tombstones and SCIM IDs are never pruned here. */
export async function pruneEnterpriseTransients(db = getAdminPrisma()) {
  return db.$transaction(async (tx) => {
    await lockEnterpriseOutbox(tx);
    const tables = ['org_sso_personal_factor_challenges', 'enterprise_recovery_challenges', 'org_sso_management_sessions',
      'org_sso_management_intents', 'org_sso_link_intents', 'org_sso_relying_intents'] as const;
    let deleted = 0;
    for (const table of tables) {
      const name = Prisma.raw(table); // Closed server-owned identifiers, never request input.
      deleted += await tx.$executeRaw`DELETE FROM ${name} WHERE id IN
        (SELECT id FROM ${name} WHERE expires_at<NOW() ORDER BY expires_at LIMIT 200)`;
    }
    await tx.$executeRaw`UPDATE organisation_email_domains SET status='EXPIRED' WHERE id IN
      (SELECT id FROM organisation_email_domains WHERE status='PENDING' AND challenge_expires_at<NOW() ORDER BY challenge_expires_at LIMIT 200)`;
    deleted += await tx.$executeRaw`DELETE FROM org_sso_flows WHERE id IN
      (SELECT f.id FROM org_sso_flows f WHERE f.expires_at<NOW()
        AND NOT EXISTS(SELECT 1 FROM org_sso_link_intents l WHERE l.flow_id=f.id AND l.expires_at>NOW()) ORDER BY f.expires_at LIMIT 200)`;
    deleted += await tx.$executeRaw`DELETE FROM org_sso_replays WHERE key IN
      (SELECT key FROM org_sso_replays WHERE expires_at<NOW()-INTERVAL '1 day' ORDER BY expires_at LIMIT 200)`;
    deleted += await tx.$executeRaw`DELETE FROM session_assurances WHERE id IN
      (SELECT a.id FROM session_assurances a WHERE a.expires_at<NOW()-INTERVAL '1 day'
        AND NOT EXISTS(SELECT 1 FROM session_assurances child WHERE child.parent_id=a.id) ORDER BY a.expires_at LIMIT 200)`;
    deleted += await tx.$executeRaw`DELETE FROM authentication_evidence WHERE id IN
      (SELECT a.id FROM authentication_evidence a WHERE a.expires_at<NOW()-INTERVAL '1 day'
        AND NOT EXISTS(SELECT 1 FROM authentication_evidence child WHERE child.parent_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM authorization_codes c WHERE c.authentication_evidence_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM signing_continuations s WHERE s.authentication_evidence_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM external_identities e WHERE e.proof_authentication_evidence_id=a.id)
        ORDER BY a.expires_at LIMIT 200)`;
    deleted += await tx.$executeRaw`DELETE FROM enterprise_recovery_actions WHERE id IN
      (SELECT id FROM enterprise_recovery_actions WHERE created_at<NOW()-INTERVAL '90 days' ORDER BY created_at LIMIT 200)`;
    return deleted;
  }, { timeout: 30000 });
}

/** Network work stays outside the authority transaction; the exact observed revision is rechecked before committing. */
export async function recheckEnterpriseDomains(resolver = boundedEnterpriseTxt, db = getAdminPrisma()) {
  const due = await db.organisationEmailDomain.findMany({ where: { status: 'VERIFIED', OR: [
    { checkedAt: null }, { checkedAt: { lt: new Date(Date.now() - 6 * 3600000) } },
  ] }, orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }], take: 10 });
  for (const observed of due) {
    let found = false;
    try { found = (await resolver(observed.emailDomain)).some((record) => hashAssuranceReference(record.join('')) === observed.challengeHash); }
    catch { /* Resolution failure counts as unavailable; no provider material is logged. */ }
    await db.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx); await lockProductTeamPolicyShared(tx);
      await lockEnterpriseScope(tx, observed.clientDomain, observed.orgId);
      const current = await tx.organisationEmailDomain.findUnique({ where: { id: observed.id } });
      if (!current || current.status !== 'VERIFIED' || current.challengeHash !== observed.challengeHash ||
        current.checkedAt?.getTime() !== observed.checkedAt?.getTime()) return;
      const failures = found ? 0 : current.failures + 1;
      const lapsed = !found && (failures >= 3 || !current.lastVerifiedAt || current.lastVerifiedAt.getTime() + 86400000 <= Date.now());
      await tx.organisationEmailDomain.update({ where: { id: current.id }, data: { checkedAt: new Date(), failures,
        ...(found ? { lastVerifiedAt: new Date() } : {}), ...(lapsed ? { status: 'LAPSED' } : {}) } });
      if (lapsed) await suspendEnterpriseDomainLinks(current, tx);
    }, { timeout: 30000 });
  }
}

export function startEnterpriseMaintenance(log: { error: (value: unknown, message: string) => void }) {
  let stopped = false; let running: Promise<void> | undefined;
  const tick = async () => {
    try { await pruneEnterpriseTransients(); if (!stopped) await recheckEnterpriseDomains(); }
    catch { log.error({ code: 'ENTERPRISE_MAINTENANCE_UNAVAILABLE' }, 'enterprise maintenance unavailable'); }
    finally { running = undefined; }
  };
  const timer = setInterval(() => { if (!stopped && !running) running = tick(); }, 60000);
  timer.unref(); running = tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; } };
}
