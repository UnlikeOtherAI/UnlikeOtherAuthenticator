import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { assertIndependentSourceStillAdmitted } from './credential-admission.service.js';
import { assertEnterpriseProvisioningActive } from './enterprise-identity-status.service.js';

/**
 * The sign-in evidence an agent connection grant was issued from, copied off the live session
 * proof at issue. The session itself may end long before the grant does, so renewal rechecks this
 * evidence against the live authorities instead of the session row.
 */
export type AgentGrantEvidence = {
  subjectId: string;
  sourceDomain: string;
  orgId: string;
  method: string;
  connectionRef: string | null;
  connectionRevision: number | null;
  connectionGeneration: number | null;
  externalIdentityId: string | null;
  mfaSource: string;
  amr: string[];
  policyGeneration: number;
};

export type AgentGrantEvidenceDb = Pick<PrismaClient,
  'orgSsoPolicy' | 'orgSsoConnection' | 'externalIdentity' | 'scimResourceLink' | 'organisationEmailDomain'
  | 'user' | 'refreshToken' | 'sessionAssurance' | 'orgMember' | 'teamMember' | 'team'
  | 'enterpriseProductReadiness'>;

function unavailable(): never {
  throw new AppError('FORBIDDEN', 403, 'AGENT_GRANT_UNAVAILABLE');
}

/**
 * The same evidence rules a session proof is held to on every use, minus its session lifetime:
 * an SSO policy change, a disabled or re-keyed enterprise connection, a deactivated or
 * deprovisioned external identity, or an independent sign-in method the account no longer admits
 * ends the grant.
 */
export async function assertAgentGrantEvidence(evidence: AgentGrantEvidence, db: AgentGrantEvidenceDb): Promise<void> {
  const policy = await db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: {
    clientDomain: evidence.sourceDomain, orgId: evidence.orgId } } });
  if ((policy?.generation ?? 0) !== evidence.policyGeneration) unavailable();
  if (evidence.method === 'independent') {
    await assertIndependentSourceStillAdmitted({ userId: evidence.subjectId, methods: evidence.amr,
      personalFactorCompleted: evidence.mfaSource === 'uoa_totp' }, db as never);
    return;
  }
  if (evidence.method !== 'sso' || !evidence.connectionRef || !evidence.externalIdentityId) unavailable();
  const [connection, identity] = await Promise.all([
    db.orgSsoConnection.findUnique({ where: { id: evidence.connectionRef } }),
    db.externalIdentity.findUnique({ where: { id: evidence.externalIdentityId } }),
  ]);
  if (!connection || connection.status !== 'active' || connection.clientDomain !== evidence.sourceDomain
    || connection.orgId !== evidence.orgId || connection.revision !== evidence.connectionRevision
    || connection.generation !== evidence.connectionGeneration || identity?.status !== 'ACTIVE'
    || identity.connectionId !== connection.id || identity.userId !== evidence.subjectId) unavailable();
  await assertEnterpriseProvisioningActive(connection.id, identity.id, evidence.subjectId, db);
}

/** Whether a grant's evidence satisfies an organisation that requires SSO for this person. */
export const agentGrantSatisfiesSsoPolicy = (evidence: AgentGrantEvidence, orgId: string): boolean =>
  evidence.method === 'sso' && evidence.orgId === orgId;
