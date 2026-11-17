import type { FastifyRequest } from 'fastify';
import { ORG_SUBJECT_ASSERTION_AUDIENCE, ORG_SUBJECT_ASSERTION_HEADER, ORG_ACCESS_TOKEN_HEADER,
  parseBearerOrRawToken, resolveOrgUserClaims } from '../middleware/org-role-guard.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { lockAndAssertAuthenticationEpochShared } from './authentication-epoch.service.js';
import { verifyConfidentialSubjectToken } from './confidential-token-exchange.service.js';
import { validateSessionAssurance } from './session-assurance.service.js';

type ValidatedAssurance = Awaited<ReturnType<typeof validateSessionAssurance>>;

/**
 * What a product is told about a proof UOA just validated. One shape for
 * `POST /org/assurance/validate` and the `assurance` block of `GET /org/me`, so a product
 * that reads either cannot be told two different things about the same proof.
 */
export function assuranceValidationAnswer(proof: ValidatedAssurance, now = Date.now()) {
  return {
    active: true as const,
    assurance_id: proof.id, method: proof.method, expires_at: proof.expiresAt.toISOString(),
    client_domain: proof.clientDomain,
    recheck_by: new Date(Math.min(now + 1800000, proof.expiresAt.getTime())).toISOString(),
    policy_generation: proof.policyGeneration,
    connection_generation: proof.connectionGeneration, connection_revision: proof.connectionRevision,
    authenticated_at: proof.authenticatedAt?.toISOString() ?? null, observed_at: proof.observedAt.toISOString(),
    ...(proof.connectionId ? { connection_id: proof.connectionId } : {}),
  };
}

export type AssuranceValidationInput = { assurance_ref: string; org_id?: string; team_id?: string };
function invalid(): never { throw new AppError('UNAUTHORIZED', 401, 'INVALID_SESSION_ASSURANCE'); }

/** Only this endpoint admits null-scope confidential originals. Organisation role
 * resolution elsewhere still requires its exact active organisation/team. */
export async function resolveOriginalAssurance(request: FastifyRequest, body: AssuranceValidationInput) {
  const domain = request.config?.domain;
  if (!domain || !request.configJwt || (body.team_id && !body.org_id)) invalid();
  const rawAssertion = request.headers[ORG_SUBJECT_ASSERTION_HEADER];
  if (!body.org_id && rawAssertion !== undefined) {
    if (request.headers[ORG_ACCESS_TOKEN_HEADER] !== undefined) invalid();
    const token = parseBearerOrRawToken(rawAssertion);
    if (!token || token.includes(',')) invalid();
    const assertion = await verifyConfidentialSubjectToken({ subjectToken: token, configJwt: request.configJwt,
      sourceDomain: domain, audience: ORG_SUBJECT_ASSERTION_AUDIENCE }, { prisma: request.adminDb });
    if (assertion.active || !assertion.verifiedAssuranceId || assertion.assurance_ref !== body.assurance_ref) invalid();
    return runInTransaction(request.adminDb, async tx => {
      await lockAndAssertAuthenticationEpochShared({ userId: assertion.sub, domain,
        credentialEpoch: assertion.tv }, { prisma: tx });
      const role = await tx.domainRole.findUnique({ where: { domain_userId: {
        domain, userId: assertion.sub } }, select: { role: true } });
      if (!role) invalid();
      const proof = await validateSessionAssurance({ reference: body.assurance_ref, userId: assertion.sub,
        credentialEpoch: assertion.tv, clientDomain: domain, requirement: 'global_account_control' }, tx);
      if (proof.id !== assertion.verifiedAssuranceId) invalid();
      return proof;
    });
  }

  // Preserve both existing person credential transports for selected scope.
  const claims = await resolveOrgUserClaims(request);
  if (claims.domain !== domain || !claims.assuranceId || (body.org_id
    ? claims.org?.org_id !== body.org_id || (body.team_id && claims.active?.teamId !== body.team_id)
    : Boolean(claims.org || claims.active))) invalid();
  const role = await request.adminDb.domainRole.findUnique({ where: { domain_userId: {
    domain, userId: claims.userId } }, select: { role: true } });
  if (!role) invalid();
  const proof = await validateSessionAssurance({ reference: body.assurance_ref, userId: claims.userId,
    credentialEpoch: claims.tokenVersion, clientDomain: domain, orgId: body.org_id, teamId: body.team_id,
    ...(!body.org_id ? { requirement: 'global_account_control' as const } : {}) }, request.adminDb);
  if (proof.id !== claims.assuranceId) invalid();
  return proof;
}
