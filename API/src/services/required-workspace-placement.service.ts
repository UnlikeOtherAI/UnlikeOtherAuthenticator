import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { buildWorkspaceChoices, resolveAutoSelectedWorkspace } from './first-login.service.js';
import {
  resolveProductWorkspacePolicy,
  type ProductWorkspacePolicy,
} from './product-workspace-policy.service.js';
import {
  ensureUserHasRequiredTeam,
  lockRequiredTeamPlacementUser,
} from './user-team-requirement.service.js';
import { lockAndAssertActiveClientWorkspaceScope } from './workspace-scope.service.js';

export type RequiredAuthorizationWorkspace = {
  orgId: string;
  teamId: string;
};

export type StoredAuthorizationWorkspace = {
  orgId: string | null;
  teamId: string | null;
};

export function requiresExactAuthorizationWorkspace(
  config: ClientConfig,
  policy: ProductWorkspacePolicy,
): boolean {
  return (
    policy.scope === 'all_active_memberships' ||
    (config.org_features?.enabled === true &&
      config.org_features.user_needs_team === true &&
      config.login_flow?.workspace_selection === 'auto')
  );
}

/**
 * Resolve the exact workspace for an originally unscoped authorization code.
 * Auto-selection may reuse one unambiguous ACTIVE choice. Product domains also
 * inspect their central cross-product choices when selection is off so an
 * existing customer workspace can never trigger a ghost product-domain org.
 * Only a user with no eligible workspace may receive a new personal placement.
 */
export async function resolveRequiredAuthorizationWorkspace(
  params: { config: ClientConfig; userId: string },
  deps: {
    env?: ReturnType<typeof getEnv>;
    afterWorkspaceLock?: () => Promise<void>;
    prisma: PrismaClient;
    workspacePrisma: PrismaClient;
  },
): Promise<RequiredAuthorizationWorkspace | null> {
  await lockRequiredTeamPlacementUser(params.userId, { prisma: deps.prisma });

  const policy = await resolveProductWorkspacePolicy(
    { domain: params.config.domain },
    { prisma: deps.workspacePrisma },
  );
  const autoSelection = params.config.login_flow?.workspace_selection === 'auto';
  const exactSelectionRequired = requiresExactAuthorizationWorkspace(params.config, policy);
  const placementAllowed =
    params.config.org_features?.enabled === true &&
    params.config.org_features.user_needs_team === true;
  if (!placementAllowed && !exactSelectionRequired) return null;

  if (autoSelection || policy.scope === 'all_active_memberships') {
    const choices = await buildWorkspaceChoices(
      { userId: params.userId, config: params.config },
      {
        crossProductPrisma: deps.workspacePrisma,
        policy,
        policyPrisma: deps.workspacePrisma,
        prisma: deps.prisma,
      },
    );
    const selected = resolveAutoSelectedWorkspace(choices);
    if (selected && (autoSelection || policy.scope === 'all_active_memberships')) {
      await validateWorkspace(params, selected, deps);
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
    // Legacy same-domain clients with workspace selection disabled historically
    // issued unscoped sessions once the user already had a team. Preserve that
    // contract; exact product/auto-selection clients are handled above.
    return null;
  }
  await validateWorkspace(params, created, deps);
  return created;
}

/**
 * Resolve a server-recognized product's exact workspace before any interactive
 * 2FA decision. Signed `workspace_selection: "off"` suppresses the chooser, but
 * it cannot defer this server-owned scope decision until token exchange.
 */
export async function resolveProductWorkspaceBeforeTwoFa(
  params: { config: ClientConfig; userId: string },
  deps: {
    env?: ReturnType<typeof getEnv>;
    afterWorkspaceLock?: () => Promise<void>;
    prisma: PrismaClient;
    workspacePrisma: PrismaClient;
  },
): Promise<RequiredAuthorizationWorkspace | null> {
  const policy = await resolveProductWorkspacePolicy(
    { domain: params.config.domain },
    { prisma: deps.workspacePrisma },
  );
  if (policy.scope !== 'all_active_memberships') return null;
  return resolveRequiredAuthorizationWorkspace(params, deps);
}

/**
 * Resolve a legacy unscoped authorization code after consumption. Recognized
 * products are deliberately excluded: their exact scope must already have
 * been bound before interactive 2FA and persisted on the code.
 */
export async function resolveAuthorizationCodeWorkspace(
  params: {
    config: ClientConfig;
    stored: StoredAuthorizationWorkspace;
    userId: string;
  },
  deps: {
    env?: ReturnType<typeof getEnv>;
    afterWorkspaceLock?: () => Promise<void>;
    prisma: PrismaClient;
    workspacePrisma: PrismaClient;
  },
): Promise<RequiredAuthorizationWorkspace | null> {
  if (params.stored.orgId && params.stored.teamId) {
    return { orgId: params.stored.orgId, teamId: params.stored.teamId };
  }
  const policy = await resolveProductWorkspacePolicy(
    { domain: params.config.domain },
    { prisma: deps.workspacePrisma },
  );
  if (policy.scope === 'all_active_memberships') {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  }
  return resolveRequiredAuthorizationWorkspace(
    { userId: params.userId, config: params.config },
    deps,
  );
}

async function validateWorkspace(
  params: { config: ClientConfig; userId: string },
  active: RequiredAuthorizationWorkspace,
  deps: {
    afterWorkspaceLock?: () => Promise<void>;
    prisma: PrismaClient;
    workspacePrisma: PrismaClient;
  },
): Promise<void> {
  await lockAndAssertActiveClientWorkspaceScope(
    { userId: params.userId, domain: params.config.domain, ...active },
    {
      crossProductPrisma: deps.workspacePrisma,
      policyPrisma: deps.workspacePrisma,
      prisma: deps.prisma,
    },
  );
  await deps.afterWorkspaceLock?.();
}
