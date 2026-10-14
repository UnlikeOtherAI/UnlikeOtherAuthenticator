import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AccessTokenClaims } from './access-token.service.js';
import type { ClientConfig } from './config.service.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { requireIdentityEmail, assertEntityAccess } from './entity-lifecycle.service.js';
import { lockTokenIssuanceProductPolicy } from './product-team-policy-lock.service.js';
import {
  lockAndAssertAuthenticationEpoch,
  lockAndAssertAuthenticationEpochShared,
} from './authentication-epoch.service.js';
import { assertActiveClientTeamScope, lockTeamMembershipRows } from './team-scope.service.js';
import { readTargetDisplay } from './profile-display.service.js';
import { withDirectoryMutation } from './directory-mutation.service.js';
import { verifyDomainAuthToken } from './domain-secret.service.js';

export const ProfilePatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    pronouns_preset: z
      .enum([
        'he_him',
        'she_her',
        'they_them',
        'any_pronouns',
        'ask_me',
        'prefer_not_to_say',
        'custom',
      ])
      .nullable()
      .optional(),
    pronouns_custom: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export type ProfileAuthority = {
  claims: AccessTokenClaims;
  expiresAt: number;
  config: ClientConfig;
  clientDomainId: string;
  domainCredential: string;
};
const forbidden = () => new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
const missing = () => new AppError('NOT_FOUND', 404);
const profileSelect = {
  id: true,
  email: true,
  name: true,
  pronounsPreset: true,
  pronounsCustom: true,
  twoFaEnabled: true,
  createdAt: true,
} as const;
const pronouns = {
  he_him: 'he/him',
  she_her: 'she/her',
  they_them: 'they/them',
  any_pronouns: 'any pronouns',
  ask_me: 'ask me',
  prefer_not_to_say: null,
} as const;

export async function assertProfileAuthority(
  authority: ProfileAuthority,
  tx: PrismaClient,
  write = false,
  pinTeamScope = true,
) {
  const { claims, config } = authority;
  if (claims.domain !== config.domain) throw forbidden();
  await lockTokenIssuanceProductPolicy(
    { domain: config.domain, clientDomainId: authority.clientDomainId },
    { prisma: tx },
  );
  const binding = await verifyDomainAuthToken(
    { domain: config.domain, token: authority.domainCredential },
    { prisma: tx },
  );
  if (binding.clientDomainId !== authority.clientDomainId) throw forbidden();
  const lockEpoch = write
    ? lockAndAssertAuthenticationEpoch
    : lockAndAssertAuthenticationEpochShared;
  await lockEpoch(
    { userId: claims.userId, domain: claims.domain, credentialEpoch: claims.tokenVersion },
    { prisma: tx },
  );
  const role = await tx.domainRole.findUnique({
    where: { domain_userId: { domain: claims.domain, userId: claims.userId } },
    select: { userId: true },
  });
  if (!role) throw forbidden();
  if (pinTeamScope && claims.active) {
    await lockTeamMembershipRows({ userId: claims.userId, ...claims.active }, { prisma: tx });
    await assertActiveClientTeamScope(
      { userId: claims.userId, domain: config.domain, ...claims.active },
      { prisma: tx, crossProductPrisma: tx, policyPrisma: tx },
    );
  }
  if (authority.expiresAt <= Date.now() / 1000) throw forbidden();
}

export async function readOrUpdateSelfProfile(
  authority: ProfileAuthority,
  prisma: PrismaClient,
  patch?: z.infer<typeof ProfilePatch>,
) {
  return runInTransaction(prisma, async (tx) => {
    if (!patch) return readOrWriteProfile(authority, tx);
    // User authority precedes sorted org locks, which precede scope row locks.
    await assertProfileAuthority(authority, tx, true, false);
    const memberships = await tx.orgMember.findMany({
      where: { userId: authority.claims.userId, org: { lifecycleStatus: { not: 'DELETED' } } },
      select: { orgId: true },
    });
    const changes = [...new Set(memberships.map((member) => member.orgId))]
      .sort()
      .map((orgId) => ({
        orgId,
        kind: 'profile.changed' as const,
        subjectId: authority.claims.userId,
      }));
    return withDirectoryMutation(tx, changes, (locked) =>
      readOrWriteProfile(authority, locked, patch),
    );
  });
}

async function readOrWriteProfile(
  authority: ProfileAuthority,
  tx: PrismaClient,
  patch?: z.infer<typeof ProfilePatch>,
) {
  await assertProfileAuthority(authority, tx, patch !== undefined);
  const user = await tx.user.findUnique({
    where: { id: authority.claims.userId },
    select: profileSelect,
  });
  if (!user) throw forbidden();
  let current = user;
  if (patch) {
    const parsed = ProfilePatch.parse(patch);
    const preset =
      parsed.pronouns_preset === undefined ? user.pronounsPreset : parsed.pronouns_preset;
    const custom =
      preset === 'custom'
        ? parsed.pronouns_custom === undefined
          ? user.pronounsCustom
          : parsed.pronouns_custom
        : null;
    if (
      (preset === 'custom' && !custom?.trim()) ||
      (parsed.pronouns_custom != null && preset !== 'custom')
    ) {
      throw new AppError('BAD_REQUEST', 400);
    }
    current = await tx.user.update({
      where: { id: user.id },
      data: {
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        pronounsPreset: preset,
        pronounsCustom: custom,
      },
      select: profileSelect,
    });
  }
  return {
    id: current.id,
    email: requireIdentityEmail(current.email),
    name: current.name,
    pronouns_preset: current.pronounsPreset,
    pronouns_custom: current.pronounsCustom,
    pronouns_display:
      current.pronounsPreset === 'custom'
        ? current.pronounsCustom
        : (pronouns[current.pronounsPreset as keyof typeof pronouns] ?? null),
    twofa_enabled: current.twoFaEnabled,
    created_at: current.createdAt.toISOString(),
  };
}

/** Exact live actor + exact target provenance. No domain-directory fallback. */
export async function readOrganisationDisplay(
  authority: ProfileAuthority,
  target: { orgId: string; userId: string },
  prisma: PrismaClient,
) {
  return runInTransaction(prisma, async (tx) => {
    await assertProfileAuthority(authority, tx);
    if (authority.claims.org?.org_id !== target.orgId) throw missing();
    await assertEntityAccess({ orgId: target.orgId }, tx);
    const actor = await tx.orgMember.findUnique({
      where: { orgId_userId: { orgId: target.orgId, userId: authority.claims.userId } },
      select: { status: true },
    });
    if (actor?.status !== 'ACTIVE') throw missing();
    return readTargetDisplay(tx, target);
  });
}
