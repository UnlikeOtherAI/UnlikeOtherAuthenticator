import type { Prisma, User, AuthenticationEvidence } from '@prisma/client';
import { getPublicBaseUrl, requireEnv } from '../config/env.js';
import { asPrismaClient } from '../db/tenant-context.js';
import { LOGIN_SESSION_AUDIENCE } from '../config/constants.js';
import type { ClientConfig } from './config.service.js';
import type { EnterpriseAuthorizationContext } from './enterprise-authorization-context.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { buildSessionChoices, resolveAutoSelectedTeam } from './first-login.service.js';
import { signLoginSession } from './login-session.service.js';
import { finalizeWithTwoFaPolicy } from './team-finalize.service.js';

/** One post-admission path for both an existing stable link and a newly proved link. */
export async function finalizeEnterpriseAdmission(admitted: { user: User; evidence: AuthenticationEvidence },
  config: ClientConfig, context: EnterpriseAuthorizationContext, tx: Prisma.TransactionClient, ip?: string) {
    await lockAndAssertAuthenticationEpoch({ userId: admitted.user.id, domain: config.domain,
      credentialEpoch: admitted.user.tokenVersion }, { prisma: tx });
    const common = { userId: admitted.user.id, credentialEpoch: admitted.user.tokenVersion, config,
      configUrl: context.config_url, redirectUrl: context.redirect_url, state: context.state,
      codeChallenge: context.code_challenge, codeChallengeMethod: 'S256' as const,
      authenticationEvidenceId: admitted.evidence.id, authMethod: 'sso', rememberMe: false, requestAccess: false };
    const choices = await buildSessionChoices(common, { prisma: tx, crossProductPrisma: tx, policyPrisma: tx });
    const selected = resolveAutoSelectedTeam(choices);
    const target = new URL('/auth', getPublicBaseUrl());
    target.searchParams.set('config_url', context.config_url); target.searchParams.set('redirect_url', context.redirect_url);
    if (!selected) {
      const loginToken = await signLoginSession({ ...common, sharedSecret: requireEnv('SHARED_SECRET').SHARED_SECRET,
        audience: LOGIN_SESSION_AUDIENCE });
      target.searchParams.set('flow', 'team_chooser'); target.searchParams.set('login_token', loginToken);
      target.searchParams.set('code_challenge', context.code_challenge); target.searchParams.set('code_challenge_method', 'S256');
    } else {
      const result = await finalizeWithTwoFaPolicy({ ...common, ...selected, ip, twoFaEnabled: admitted.user.twoFaEnabled },
        { prisma: asPrismaClient(tx), teamPrisma: asPrismaClient(tx), policyPrisma: asPrismaClient(tx), policyLockHeld: true });
      if (result.kind === 'granted') return { destination: result.finalResult.redirectTo, retainBrowser: false };
      if (result.kind === 'twofa') target.searchParams.set('twofa_token', result.twofa_token);
      else { target.searchParams.set('twofa_enroll_required', 'true'); target.searchParams.set('twofa_setup_token', result.setup.setup_token); }
    }
    return { destination: target.toString(), retainBrowser: false };
}
