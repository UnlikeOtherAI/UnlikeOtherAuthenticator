import { z } from 'zod';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { randomBytes } from 'node:crypto';
import { getPublicBaseUrl } from '../config/env.js';
import { authorizeCredentialSurface } from './credential-route-registry.service.js';
import { requireAuthenticationEvidence } from './authentication-evidence.service.js';
import { machineEqual, machineHash, machineMac, machineRefused } from './machine-crypto.js';
import { machineClock, requireMachineProduct, type MachineDb } from './machine-authority.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { lockAndAssertActiveClientTeamScope } from './team-scope.service.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import type { ClientConfig } from './config.service.js';
import { MachineBinding, MACHINE_CONSENT_MS } from './machine-contract.js';

export function machineCsrf(browser: string): string { return machineMac('csrf', browser); }
export async function createMachineBrowser(input: { userId: string; domain: string; credentialEpoch: number;
  evidenceId?: string; config: ClientConfig; configUrl: string; orgId: string; teamId: string; requestId?: string; codeChallenge?: string; state?: string }, tx: MachineDb) {
  const evidence = await requireAuthenticationEvidence({ id: input.evidenceId, userId: input.userId,
    credentialEpoch: input.credentialEpoch, clientDomain: input.domain }, tx);
  if (evidence.purpose !== 'authorize') machineRefused();
  await requireMachineProduct(input.domain, tx);
  await lockAndAssertActiveClientTeamScope({ userId: input.userId, domain: input.domain, orgId: input.orgId,
    teamId: input.teamId }, { prisma: tx, policyPrisma: tx, crossProductPrisma: tx });
  const now = await machineClock(tx);
  if (input.requestId) {
    const request = await tx.machineAuthorizationRequest.findUnique({ where: { id: input.requestId } });
    if (!request || request.clientDomain !== input.domain || request.configUrl !== input.configUrl ||
      request.configFingerprint !== fingerprintClientConfig(input.config) || !request.proofHash ||
      request.expiresAt <= now || request.consentedAt || request.deniedAt ||
      input.codeChallenge !== machineMac('request-pkce', request.id) || input.state !== request.id) machineRefused();
    const binding = MachineBinding.parse(request.binding);
    if (binding.subject !== input.userId || binding.organization_id !== input.orgId || binding.team_id !== input.teamId) machineRefused();
  }
  const browser = randomBytes(32).toString('base64url');
  const session = await tx.machineBrowserSession.create({ data: { subject: input.userId,
    clientDomain: input.domain, configUrl: input.configUrl, configFingerprint: fingerprintClientConfig(input.config),
    orgId: input.orgId, teamId: input.teamId, requestId: input.requestId, evidenceId: evidence.id,
    credentialEpoch: input.credentialEpoch, browserHash: machineHash(browser),
    expiresAt: new Date(Math.min(evidence.expiresAt.getTime(), now.getTime() + MACHINE_CONSENT_MS)) } });
  return { session, browser: `${session.id}.${browser}` };
}
/** Invoked by canonical post-factor AND agreement finalization; never issues a product code. */
export async function finishMachineAuthentication(input: { id: string; userId: string; credentialEpoch: number;
  domain: string; authenticationEvidenceId?: string; orgId?: string; teamId?: string; twoFaCompleted: boolean }, tx: MachineDb) {
  const row = await tx.machineBrowserSession.findUnique({ where: { id: input.id } });
  const now = await machineClock(tx);
  if (!row || row.finalizedAt || row.subject !== input.userId || row.clientDomain !== input.domain ||
    row.credentialEpoch !== input.credentialEpoch || row.evidenceId !== input.authenticationEvidenceId ||
    row.orgId !== input.orgId || row.teamId !== input.teamId || row.expiresAt <= now) machineRefused();
  const evidence = await requireAuthenticationEvidence({ id: row.evidenceId, userId: row.subject,
    clientDomain: row.clientDomain, credentialEpoch: row.credentialEpoch }, tx);
  const user = await tx.user.findUnique({ where: { id: row.subject }, select: { twoFaEnabled: true } });
  const freshAt = Math.max(evidence.observedAt.getTime(), evidence.authenticatedAt?.getTime() ?? 0,
    evidence.mfaCompletedAt?.getTime() ?? 0);
  if (!user || freshAt + MACHINE_CONSENT_MS <= now.getTime() ||
    (user.twoFaEnabled && (!input.twoFaCompleted || !evidence.mfaCompletedAt))) machineRefused();
  const used = await tx.authenticationEvidence.updateMany({ where: { id: evidence.id, consumedAt: null }, data: { consumedAt: now } });
  if (used.count !== 1) machineRefused();
  await tx.machineBrowserSession.update({ where: { id: row.id }, data: { finalizedAt: now,
    authenticatedAt: new Date(freshAt), expiresAt: new Date(Math.min(row.expiresAt.getTime(), freshAt + MACHINE_CONSENT_MS)) } });
  const home = new URL('/auth/machines', getPublicBaseUrl());
  home.searchParams.set('config_url', row.configUrl);
  return { status: 'machine' as const, redirectTo: home.toString() };
}
export async function machineBrowser(cookie: string | undefined, tx: MachineDb, csrf?: string) {
  await lockProductTeamPolicyShared(tx);
  const [id, browser, extra] = (cookie ?? '').split('.');
  if (!z.uuid().safeParse(id).success || !/^[A-Za-z0-9_-]{43}$/.test(browser ?? '') || extra) machineRefused();
  const row = await tx.machineBrowserSession.findUnique({ where: { id } });
  const now = await machineClock(tx);
  if (!row?.finalizedAt || row.expiresAt <= now || row.browserHash !== machineHash(browser)) machineRefused();
  if (csrf !== undefined && !machineEqual(machineCsrf(browser), csrf)) machineRefused();
  await lockAndAssertAuthenticationEpoch({ userId: row.subject, domain: row.clientDomain,
    credentialEpoch: row.credentialEpoch }, { prisma: tx });
  await requireMachineProduct(row.clientDomain, tx);
  await lockAndAssertActiveClientTeamScope({ userId: row.subject, domain: row.clientDomain,
    orgId: row.orgId, teamId: row.teamId }, { prisma: tx, policyPrisma: tx, crossProductPrisma: tx });
  await authorizeCredentialSurface('configured_authorization', { userId: row.subject,
    clientDomain: row.clientDomain, credentialEpoch: row.credentialEpoch, orgId: row.orgId, teamId: row.teamId,
    authenticationEvidenceId: row.evidenceId, allowConsumedEvidence: true }, tx);
  return { ...row, csrf: machineCsrf(browser) };
}
