import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { buildSessionChoices, resolveAutoSelectedTeam } from './first-login.service.js';
import {
  resolveProductTeamPolicy,
  type ProductTeamPolicy,
} from './product-team-policy.service.js';
import {
  ensureUserHasRequiredTeam,
  lockRequiredTeamPlacementUser,
} from './user-team-requirement.service.js';
import { lockAndAssertActiveClientTeamScope } from './team-scope.service.js';

export type RequiredAuthorizationTeam = {
  orgId: string;
  teamId: string;
};

export type StoredAuthorizationTeam = {
  orgId: string | null;
  teamId: string | null;
};

export function requiresExactAuthorizationTeam(
  config: ClientConfig,
  policy: ProductTeamPolicy,
): boolean {
  return (
    policy.scope === 'all_active_memberships' ||
    (config.org_features?.enabled === true &&
      config.org_features.user_needs_team === true &&
      config.login_flow?.team_selection === 'auto')
  );
}

/**
 * Resolve the exact team for an originally unscoped authorization code.
 * Auto-selection may reuse one unambiguous ACTIVE choice. Product domains also
 * inspect their central cross-product choices when selection is off so an
 * existing customer team can never trigger a ghost product-domain org.
 * Only a user with no eligible team may receive a new personal placement.
 */
export async function resolveRequiredAuthorizationTeam(
  params: { config: ClientConfig; userId: string },
  deps: {
    env?: ReturnType<typeof getEnv>;
    afterTeamLock?: () => Promise<void>;
    prisma: PrismaClient;
    teamPrisma: PrismaClient;
  },
): Promise<RequiredAuthorizationTeam | null> {
  await lockRequiredTeamPlacementUser(params.userId, { prisma: deps.prisma });

  const policy = await resolveProductTeamPolicy(
    { domain: params.config.domain },
    { prisma: deps.teamPrisma },
  );
  const autoSelection = params.config.login_flow?.team_selection === 'auto';
  const exactSelectionRequired = requiresExactAuthorizationTeam(params.config, policy);
  const placementAllowed =
    params.config.org_features?.enabled === true &&
    params.config.org_features.user_needs_team === true;
  if (!placementAllowed && !exactSelectionRequired) return null;

  if (autoSelection || policy.scope === 'all_active_memberships') {
    const choices = await buildSessionChoices(
      { userId: params.userId, config: params.config },
      {
        crossProductPrisma: deps.teamPrisma,
        policy,
        policyPrisma: deps.teamPrisma,
        prisma: deps.prisma,
      },
    );
    const selected = resolveAutoSelectedTeam(choices);
    if (selected && (autoSelection || policy.scope === 'all_active_memberships')) {
      await validateTeam(params, selected, deps);
      return selected;
    }
    if (choices.teams.length > 0 || choices.pending_invites.length > 0) {
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
    }
  }

  if (!placementAllowed) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  }

  const created = await ensureUserHasRequiredTeam(params, {
    env: deps.env,
    prisma: deps.prisma,
  });
  if (!created) {
    if (exactSelectionRequired) {
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
    }
    // Legacy same-domain clients with team selection disabled historically
    // issued unscoped sessions once the user already had a team. Preserve that
    // contract; exact product/auto-selection clients are handled above.
    return null;
  }
  await validateTeam(params, created, deps);
  return created;
}

/**
 * Resolve a server-recognized product's exact team before any interactive
 * 2FA decision. Signed `team_selection: "off"` suppresses the chooser, but
 * it cannot defer this server-owned scope decision until token exchange.
 */
export async function resolveProductTeamBeforeTwoFa(
  params: { config: ClientConfig; userId: string },
  deps: {
    env?: ReturnType<typeof getEnv>;
    afterTeamLock?: () => Promise<void>;
    prisma: PrismaClient;
    teamPrisma: PrismaClient;
  },
): Promise<RequiredAuthorizationTeam | null> {
  const policy = await resolveProductTeamPolicy(
    { domain: params.config.domain },
    { prisma: deps.teamPrisma },
  );
  if (policy.scope !== 'all_active_memberships') return null;
  return resolveRequiredAuthorizationTeam(params, deps);
}

/**
 * Resolve a legacy unscoped authorization code after consumption. Recognized
 * products are deliberately excluded: their exact scope must already have
 * been bound before interactive 2FA and persisted on the code.
 */
export async function resolveAuthorizationCodeTeam(
  params: {
    config: ClientConfig;
    stored: StoredAuthorizationTeam;
    userId: string;
  },
  deps: {
    env?: ReturnType<typeof getEnv>;
    afterTeamLock?: () => Promise<void>;
    prisma: PrismaClient;
    teamPrisma: PrismaClient;
  },
): Promise<RequiredAuthorizationTeam | null> {
  if (params.stored.orgId && params.stored.teamId) {
    return { orgId: params.stored.orgId, teamId: params.stored.teamId };
  }
  const policy = await resolveProductTeamPolicy(
    { domain: params.config.domain },
    { prisma: deps.teamPrisma },
  );
  if (policy.scope === 'all_active_memberships') {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  }
  return resolveRequiredAuthorizationTeam(
    { userId: params.userId, config: params.config },
    deps,
  );
}

async function validateTeam(
  params: { config: ClientConfig; userId: string },
  active: RequiredAuthorizationTeam,
  deps: {
    afterTeamLock?: () => Promise<void>;
    prisma: PrismaClient;
    teamPrisma: PrismaClient;
  },
): Promise<void> {
  await lockAndAssertActiveClientTeamScope(
    { userId: params.userId, domain: params.config.domain, ...active },
    {
      crossProductPrisma: deps.teamPrisma,
      policyPrisma: deps.teamPrisma,
      prisma: deps.prisma,
    },
  );
  await deps.afterTeamLock?.();
}
