import { z } from 'zod';

import {
  DEFAULT_ORG_ROLES,
  DEFAULT_TEAM_ROLES,
  OWNER_ROLE,
  ROLE_GRANT_SCOPES,
  resolveKnownCapabilities,
  type RoleGrantScope,
} from './role-grants.js';

/**
 * `org_features` — the org/team/group feature block of the client config JWT (brief §24.1).
 *
 * Split out of `config.service.ts` when `team_roles` / `capabilities` / `role_grants` were added
 * (`Docs/plans/2026-08-16-configurable-roles-and-capabilities.md`, wave 1): the block plus its
 * cross-field validation is a cohesive unit, and keeping it inline would have pushed
 * `config.service.ts` further past the 500-line cap. Nothing about the pre-existing fields changed
 * in the move.
 */

const RoleNameSchema = z.string().min(1).max(50);

/**
 * A capability name. Deliberately just a bounded non-empty string: the closed set that matters is
 * the product's declared catalogue plus UOA's own, checked in `superRefine` below, not a syntax.
 */
const CapabilityNameSchema = z.string().trim().min(1).max(100);

const RoleGrantsSchema = z
  .object({
    org: z.record(RoleNameSchema, z.array(CapabilityNameSchema)).optional(),
    team: z.record(RoleNameSchema, z.array(CapabilityNameSchema)).optional(),
  })
  // Strict: a future `"group"` scope key slots in by being added here, and until it is, a typo'd
  // scope fails loudly instead of granting nothing in silence.
  .strict();

const BaseOrgFeaturesSchema = z.object({
  enabled: z.boolean().default(false),
  groups_enabled: z.boolean().default(false),
  user_needs_team: z.boolean().default(false),
  auto_create_personal_org_on_first_login: z.boolean().default(false),
  allow_user_create_org: z.boolean().default(false),
  // Opt-in for creating a further team (team) inside an org the user is already an
  // ACTIVE owner/admin of, straight from the SSO team chooser. Separate from
  // `allow_user_create_org`, which is about a user's *first* org: this one adds a write path
  // to an existing tenant, so a domain opts into it explicitly and the role check still
  // applies on top. Default false — no domain gains the popup write path silently.
  allow_user_create_team: z.boolean().default(false),
  // Opt-in for backend mode on `/org/*` (brief §24.8): when true, this
  // domain's product backend may call `/org/*` with NO `X-UOA-Access-Token`
  // and be authorised by the domain pairing alone. Default false, so no
  // existing domain gains the mode silently.
  //
  // This is a blast-radius control, not a new credential. The domain-hash
  // bearer and the config-signing private key are two separate secrets;
  // requiring the flag means a leaked bearer alone cannot rewrite the org
  // graph — the attacker would also have to get this flag into a config JWT
  // signed by the partner's own key.
  backend_org_management: z.boolean().default(false),
  pending_invites_block_auto_create: z.boolean().default(true),
  max_teams_per_org: z.number().int().positive().max(1000).default(100),
  max_groups_per_org: z.number().int().positive().max(200).default(20),
  max_members_per_org: z.number().int().positive().max(10000).default(1000),
  max_members_per_team: z.number().int().positive().max(5000).default(200),
  max_members_per_group: z.number().int().positive().max(5000).default(500),
  max_team_memberships_per_user: z.number().int().positive().max(200).default(50),
  org_roles: z
    .array(RoleNameSchema)
    .refine((roles) => roles.includes(OWNER_ROLE), { message: 'org_roles must include "owner"' })
    .default([...DEFAULT_ORG_ROLES]),
  // The team-role vocabulary, mirroring `org_roles`. Before this existed the three canonical team
  // roles were the law (`ALLOWED_TEAM_ROLES`); they are now only the default, and a domain may name
  // its own — `owner` stays mandatory because UOA enforces fixed semantics for it.
  team_roles: z
    .array(RoleNameSchema)
    .refine((roles) => roles.includes(OWNER_ROLE), { message: 'team_roles must include "owner"' })
    .default([...DEFAULT_TEAM_ROLES]),
  // The consuming product's declared capability catalogue, mirrored here so `role_grants` can be
  // validated against it. UOA's own capability names are always legal on top of this list.
  capabilities: z.array(CapabilityNameSchema).optional(),
  // role → capability names, per scope. Absent means the legacy default table (see
  // `role-grants.ts` `LEGACY_DEFAULT_ROLE_GRANTS`), which reproduces today's behaviour.
  role_grants: RoleGrantsSchema.optional(),
  max_flags_per_app: z.number().int().positive().max(500).default(100),
  scim_override_retention: z.enum(['retain', 'clear']).default('retain'),
  global_missing_flag_default: z.enum(['enabled', 'disabled']).default('disabled'),
});

type ParsedOrgFeatures = z.infer<typeof BaseOrgFeaturesSchema>;

function validateRoleGrants(features: ParsedOrgFeatures, ctx: z.RefinementCtx): void {
  const grants = features.role_grants;
  if (!grants) return;

  const knownCapabilities = resolveKnownCapabilities({ org_features: features });

  for (const scope of ROLE_GRANT_SCOPES) {
    const table: Record<string, string[]> | undefined = grants[scope as RoleGrantScope];
    if (!table) continue;

    const vocabulary = new Set(scope === 'org' ? features.org_roles : features.team_roles);

    for (const [role, capabilities] of Object.entries(table)) {
      if (role === OWNER_ROLE) {
        // Owner is structurally every capability. Letting a config write a row for it would let a
        // domain lock its own recovery role out of fixing that config.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `role_grants.${scope} must not name "owner" — owner implicitly holds every capability`,
          path: ['role_grants', scope, role],
        });
        continue;
      }

      if (!vocabulary.has(role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `role_grants.${scope} names "${role}", which is not in ${scope}_roles`,
          path: ['role_grants', scope, role],
        });
      }

      capabilities.forEach((capability, index) => {
        if (knownCapabilities.has(capability)) return;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `role_grants.${scope}.${role} names undeclared capability "${capability}"`,
          path: ['role_grants', scope, role, index],
        });
      });
    }
  }
}

export const OrgFeaturesSchema = BaseOrgFeaturesSchema.superRefine(validateRoleGrants)
  .optional()
  .default({
    enabled: false,
    groups_enabled: false,
    user_needs_team: false,
    auto_create_personal_org_on_first_login: false,
    allow_user_create_org: false,
    allow_user_create_team: false,
    backend_org_management: false,
    pending_invites_block_auto_create: true,
    max_teams_per_org: 100,
    max_groups_per_org: 20,
    max_members_per_org: 1000,
    max_members_per_team: 200,
    max_members_per_group: 500,
    max_team_memberships_per_user: 50,
    org_roles: [...DEFAULT_ORG_ROLES],
    team_roles: [...DEFAULT_TEAM_ROLES],
    max_flags_per_app: 100,
    scim_override_retention: 'retain',
    global_missing_flag_default: 'disabled',
  });
