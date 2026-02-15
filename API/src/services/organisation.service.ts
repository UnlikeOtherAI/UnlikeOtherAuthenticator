import { randomBytes } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import {
  AddOrgMemberInput,
  CreateOrganisationInput,
  DeleteOrganisationInput,
  GetOrganisationInput,
  ListOrgMembersInput,
  ListOrganisationsInput,
  OrgLimits,
  OrgMemberRecord,
  OrganisationServiceError,
  PaginationResult,
  RemoveOrgMemberInput,
  TransferOwnershipInput,
  UpdateOrgMemberRoleInput,
  UpdateOrganisationInput,
} from './organisation.service.types.js';

export * from './organisation.service.types.js';

type OrgTransactionClient = Prisma.TransactionClient;

const RESERVED_ORG_SLUGS = new Set([
  'admin',
  'api',
  'internal',
  'me',
  'system',
  'settings',
  'new',
  'default',
]);

const DEFAULT_TEAM_NAME = 'General';
const TEAM_ROLE_MEMBER = 'member';
const TEAM_ROLE_LEAD = 'lead';

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeDomain(rawDomain: string) {
  return rawDomain.trim().toLowerCase();
}

function normalizeName(rawName: string): string {
  const name = rawName.trim();
  if (!name) {
    throw new OrganisationServiceError('VALIDATION_ERROR', 'Organisation name is required.');
  }
  if (name.length > 100) {
    throw new OrganisationServiceError('VALIDATION_ERROR', 'Organisation name must be at most 100 characters.');
  }

  return name;
}

function normalizeRole(rawRole: string): string {
  return rawRole.trim().toLowerCase();
}

function normalizeRoleList(rawRoles: string[]): string[] {
  return rawRoles
    .map((role) => role.trim().toLowerCase())
    .filter((role) => Boolean(role));
}

function generateSlugSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(4).toString('hex');
  let suffix = '';

  for (let i = 0; i < bytes.length && suffix.length < 4; i += 1) {
    const index = Number.parseInt(bytes[i], 16) % alphabet.length;
    suffix += alphabet[index];
  }

  return suffix.padEnd(4, 'a').slice(0, 4);
}

function slugPatternMatch(slug: string) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug);
}

export class OrganisationService {
  private static readonly DEFAULT_LIMITS: OrgLimits = {
    maxTeamsPerOrg: 100,
    maxMembersPerOrg: 1000,
    maxTeamMembershipsPerUser: 50,
  };

  constructor(
    private readonly prisma: PrismaClient = new PrismaClient(),
    private readonly limits: OrgLimits = OrganisationService.DEFAULT_LIMITS,
  ) {}

  async listOrganisationsByDomain(
    input: ListOrganisationsInput,
  ): Promise<PaginationResult<Prisma.OrganisationGetPayload<{ select: typeof orgListSelect }>>> {
    const domain = normalizeDomain(input.domain);
    const limit = this.normalizeLimit(input.limit);

    const orgs = await this.prisma.organisation.findMany({
      where: { domain },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      cursor: input.cursor ? { id: input.cursor } : undefined,
      skip: input.cursor ? 1 : 0,
      take: limit + 1,
      select: orgListSelect,
    });

    const hasNext = orgs.length > limit;
    const data = hasNext ? orgs.slice(0, limit) : orgs;

    return {
      data,
      nextCursor: hasNext ? orgs.at(-1)?.id ?? null : null,
    };
  }

  async getOrganisation(input: GetOrganisationInput) {
    const { orgId, domain } = input;
    const org = await this.prisma.organisation.findFirst({
      where: { id: orgId, domain: normalizeDomain(domain) },
    });

    if (!org) {
      throw new OrganisationServiceError('ORG_NOT_FOUND', 'Organisation not found.', 404);
    }

    return org;
  }

  async createOrganisation(input: CreateOrganisationInput) {
    const domain = normalizeDomain(input.domain);
    const name = normalizeName(input.name);
    const ownerRole = normalizeRole(input.ownerRole);

    const allowedRoles = normalizeRoleList(input.allowedRoles);
    this.assertRoleAllowed(ownerRole, allowedRoles);

    if (!input.ownerUserId?.trim()) {
      throw new OrganisationServiceError('VALIDATION_ERROR', 'ownerUserId is required.');
    }

    return this.prisma.$transaction(async (tx) => {
      const owner = await tx.user.findUnique({
        where: { id: input.ownerUserId },
        select: { id: true },
      });
      if (!owner) {
        throw new OrganisationServiceError('VALIDATION_ERROR', 'Owner user does not exist.', 400);
      }

      const existingOrgMembership = await tx.orgMember.findFirst({
        where: {
          userId: input.ownerUserId,
          org: {
            domain,
          },
        },
      });

      if (existingOrgMembership) {
        throw new OrganisationServiceError(
          'CONFLICT',
          'User already belongs to an organisation on this domain.',
          409,
        );
      }

      const slug = await this.generateUniqueSlug(domain, name, tx);
      const org = await tx.organisation.create({
        data: {
          domain,
          name,
          slug,
          ownerId: input.ownerUserId,
        },
      });

      await tx.orgMember.create({
        data: {
          orgId: org.id,
          userId: input.ownerUserId,
          role: ownerRole || 'owner',
        },
      });

      const team = await tx.team.create({
        data: {
          orgId: org.id,
          name: DEFAULT_TEAM_NAME,
          isDefault: true,
        },
      });

      await tx.teamMember.create({
        data: {
          teamId: team.id,
          userId: input.ownerUserId,
          role: TEAM_ROLE_MEMBER,
        },
      });

      return { ...org };
    });
  }

  async updateOrganisation(input: UpdateOrganisationInput) {
    const domain = normalizeDomain(input.domain);
    const name = normalizeName(input.name);

    return this.prisma.$transaction(async (tx) => {
      const org = await this.requireOrgInDomain(tx, input.orgId, domain);

      const slug = await this.generateUniqueSlug(domain, name, tx, org.slug);

      return tx.organisation.update({
        where: { id: org.id },
        data: {
          name,
          slug,
        },
      });
    });
  }

  async deleteOrganisation(input: DeleteOrganisationInput) {
    const domain = normalizeDomain(input.domain);

    const org = await this.requireOrgInDomain(this.prisma, input.orgId, domain);
    if (org.ownerId !== input.callerUserId) {
      throw new OrganisationServiceError('UNAUTHORIZED', 'Only the owner can delete an organisation.', 403);
    }

    await this.prisma.orgMember.deleteMany({
      where: { orgId: org.id },
    });

    await this.prisma.organisation.delete({
      where: { id: org.id },
    });
  }

  async transferOwnership(input: TransferOwnershipInput) {
    const domain = normalizeDomain(input.domain);
    const ownerRole = normalizeRole('owner');

    const allowedRoles = normalizeRoleList(input.allowedRoles);
    this.assertRoleAllowed(ownerRole, allowedRoles);

    return this.prisma.$transaction(async (tx) => {
      const org = await this.requireOrgInDomain(tx, input.orgId, domain);

      if (org.ownerId !== input.callerUserId) {
        throw new OrganisationServiceError('UNAUTHORIZED', 'Only the current owner can transfer ownership.', 403);
      }

      const newOwner = await tx.orgMember.findUnique({
        where: {
          orgId_userId: {
            orgId: org.id,
            userId: input.newOwnerUserId,
          },
        },
      });

      if (!newOwner) {
        throw new OrganisationServiceError('MEMBER_NOT_FOUND', 'New owner must be a member of the organisation.', 404);
      }

      await tx.organisation.update({
        where: { id: org.id },
        data: { ownerId: input.newOwnerUserId },
      });

      await tx.orgMember.update({
        where: {
          id: newOwner.id,
        },
        data: {
          role: ownerRole,
        },
      });

      return {
        id: org.id,
        ownerId: input.newOwnerUserId,
      };
    });
  }

  async listMembers(input: ListOrgMembersInput): Promise<PaginationResult<OrgMemberRecord>> {
    const domain = normalizeDomain(input.domain);
    const org = await this.requireOrgInDomain(this.prisma, input.orgId, domain);
    const limit = this.normalizeLimit(input.limit);

    const members = await this.prisma.orgMember.findMany({
      where: { orgId: org.id },
      orderBy: { createdAt: 'asc' },
      cursor: input.cursor ? { id: input.cursor } : undefined,
      skip: input.cursor ? 1 : 0,
      take: limit + 1,
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const hasNext = members.length > limit;
    const data = hasNext ? members.slice(0, limit) : members;

    return {
      data,
      nextCursor: hasNext ? members.at(-1)?.id ?? null : null,
    };
  }

  async addMember(input: AddOrgMemberInput): Promise<OrgMemberRecord> {
    const domain = normalizeDomain(input.domain);
    const role = normalizeRole(input.role || 'member');

    if (!input.userId?.trim()) {
      throw new OrganisationServiceError('VALIDATION_ERROR', 'userId is required.');
    }

    return this.prisma.$transaction(async (tx) => {
      const org = await this.requireOrgInDomain(tx, input.orgId, domain);
      const limits = input.limits ?? this.limits;
      const memberCount = await tx.orgMember.count({ where: { orgId: org.id } });
      if (memberCount >= limits.maxMembersPerOrg) {
        throw new OrganisationServiceError(
          'LIMIT_EXCEEDED',
          `Organisation cannot exceed ${limits.maxMembersPerOrg} members.`,
          409,
        );
      }

      const callerRole = await this.requireOrgMember(tx, org.id, input.callerUserId);
      if (normalizeRole(callerRole.role) === 'owner' && input.userId === org.ownerId) {
        // Owner may keep same role but cannot re-add themselves via this route.
        throw new OrganisationServiceError('CONFLICT', 'Cannot add existing member again.', 409);
      }

      const existing = await tx.orgMember.findUnique({
        where: {
          orgId_userId: {
            orgId: org.id,
            userId: input.userId,
          },
        },
      });

      if (existing) {
        throw new OrganisationServiceError('CONFLICT', 'User is already a member of the organisation.', 409);
      }

      const existingInDomain = await tx.orgMember.findFirst({
        where: {
          userId: input.userId,
          org: {
            domain,
          },
        },
      });

      if (existingInDomain) {
        throw new OrganisationServiceError(
          'CONFLICT',
          'User already belongs to another organisation on this domain.',
          409,
        );
      }

      const defaultTeam = await tx.team.findFirst({
        where: {
          orgId: org.id,
          isDefault: true,
        },
        select: { id: true },
      });

      if (!defaultTeam) {
        throw new OrganisationServiceError('NOT_FOUND', 'Default team is missing.');
      }

      const allowedRoles = normalizeRoleList(input.allowedRoles ?? []);
      if (input.allowedRoles?.length) {
        this.assertRoleAllowed(role, allowedRoles);
      }

      const userExists = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      });
      if (!userExists) {
        throw new OrganisationServiceError('NOT_FOUND', 'User does not exist.', 404);
      }

      const membership = await tx.orgMember.create({
        data: {
          orgId: org.id,
          userId: input.userId,
          role,
        },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.teamMember.create({
        data: {
          teamId: defaultTeam.id,
          userId: input.userId,
          role: TEAM_ROLE_MEMBER,
        },
      });

      return membership;
    });
  }

  async updateMemberRole(input: UpdateOrgMemberRoleInput): Promise<OrgMemberRecord> {
    const domain = normalizeDomain(input.domain);
    const role = normalizeRole(input.role);
    this.assertRoleAllowed(role, normalizeRoleList(input.allowedRoles));

    return this.prisma.$transaction(async (tx) => {
      const org = await this.requireOrgInDomain(tx, input.orgId, domain);
      await this.requireOrgMember(tx, org.id, input.callerUserId);

      const membership = await tx.orgMember.findUnique({
        where: {
          orgId_userId: {
            orgId: org.id,
            userId: input.userId,
          },
        },
      });

      if (!membership) {
        throw new OrganisationServiceError('MEMBER_NOT_FOUND', 'Member not found.', 404);
      }

      if (membership.userId === org.ownerId && normalizeRole(membership.role) === 'owner' && role !== 'owner') {
        throw new OrganisationServiceError('LAST_OWNER', 'The organisation owner must remain owner.', 403);
      }

      return tx.orgMember.update({
        where: { id: membership.id },
        data: { role },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });
  }

  async removeMember(input: RemoveOrgMemberInput): Promise<void> {
    const domain = normalizeDomain(input.domain);

    return this.prisma.$transaction(async (tx) => {
      const org = await this.requireOrgInDomain(tx, input.orgId, domain);
      const actor = await this.requireOrgMember(tx, org.id, input.callerUserId);

      const membership = await tx.orgMember.findUnique({
        where: {
          orgId_userId: {
            orgId: org.id,
            userId: input.userId,
          },
        },
      });

      if (!membership) {
        throw new OrganisationServiceError('MEMBER_NOT_FOUND', 'Member not found.', 404);
      }

      if (membership.userId === org.ownerId && normalizeRole(actor.role) !== 'owner') {
        throw new OrganisationServiceError('UNAUTHORIZED', 'Only owners can remove the owner.', 403);
      }

      if (normalizeRole(membership.role) === 'owner' && membership.userId === org.ownerId) {
        const owners = await tx.orgMember.count({
          where: {
            orgId: org.id,
            role: 'owner',
          },
        });

        if (owners < 2) {
          throw new OrganisationServiceError('LAST_OWNER', 'Cannot remove the only owner.', 409);
        }
      }

      await tx.teamMember.deleteMany({
        where: {
          userId: input.userId,
          team: {
            orgId: org.id,
          },
        },
      });

      const groupIds = await tx.group.findMany({
        where: { orgId: org.id },
        select: { id: true },
      });

      await tx.groupMember.deleteMany({
        where: {
          userId: input.userId,
          groupId: {
            in: groupIds.map((group) => group.id),
          },
        },
      });

      await tx.orgMember.delete({
        where: { id: membership.id },
      });
    });
  }

  private normalizeLimit(limit?: number) {
    const requested = Number(limit ?? 50);
    if (!Number.isFinite(requested)) {
      return 50;
    }

    return Math.min(200, Math.max(1, Math.floor(requested)));
  }

  private assertRoleAllowed(role: string, allowedRoles: string[]) {
    if (!allowedRoles.includes(role)) {
      throw new OrganisationServiceError('VALIDATION_ERROR', 'Role is not allowed for this organisation.');
    }
  }

  private async generateUniqueSlug(
    domain: string,
    name: string,
    tx: OrgTransactionClient,
    currentSlug?: string,
  ) {
    const baseSlug = this.slugify(name);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug =
        attempt === 0
          ? baseSlug
          : `${baseSlug.slice(0, Math.max(116, 0))}-${generateSlugSuffix()}`;

      if (slug.length > 120) {
        continue;
      }

      if (currentSlug && slug === currentSlug) {
        return slug;
      }

      const exists = await tx.organisation.findUnique({
        where: {
          domain_slug: {
            domain,
            slug,
          },
        },
        select: { id: true },
      });

      if (!exists) {
        return slug;
      }
    }

    throw new OrganisationServiceError(
      'LIMIT_EXCEEDED',
      'Unable to generate a unique slug for this organisation name.',
      409,
    );
  }

  private slugify(name: string) {
    const lowered = stripDiacritics(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const slug = lowered.slice(0, 120);

    if (!slugPatternMatch(slug)) {
      throw new OrganisationServiceError(
        'VALIDATION_ERROR',
        'Organisation name must contain at least two URL-safe characters.',
      );
    }

    if (slug.length < 2) {
      throw new OrganisationServiceError(
        'VALIDATION_ERROR',
        'Organisation slug must be at least 2 characters long.',
      );
    }

    if (RESERVED_ORG_SLUGS.has(slug)) {
      throw new OrganisationServiceError('VALIDATION_ERROR', 'Organisation slug is reserved.', 409);
    }

    return slug;
  }

  private async requireOrgMember(tx: OrgTransactionClient, orgId: string, userId: string) {
    const membership = await tx.orgMember.findUnique({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
    });

    if (!membership) {
      throw new OrganisationServiceError('UNAUTHORIZED', 'User is not a member of this organisation.', 403);
    }

    return membership;
  }

  private async requireOrgInDomain(tx: OrgTransactionClient, orgId: string, domain: string) {
    const org = await tx.organisation.findFirst({
      where: {
        id: orgId,
        domain,
      },
    });

    if (!org) {
      throw new OrganisationServiceError('ORG_NOT_FOUND', 'Organisation does not belong to this domain.', 404);
    }

    return org;
  }
}

const orgListSelect = {
  id: true,
  domain: true,
  name: true,
  slug: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganisationSelect;
