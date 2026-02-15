import { AppError } from '../utils/errors.js';

import {
  assertDatabaseEnabled,
  getOrganisationMember,
  resolveOrganisationByDomain,
  toListLimit,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
  isP2002Error,
} from './organisation.service.base.js';
import type { ClientConfig } from './config.service.js';

import type { TeamRecord } from './team.service.base.js';

export type GroupRecord = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupMemberRecord = {
  id: string;
  groupId: string;
  userId: string;
  isAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupWithMembersRecord = GroupRecord & {
  teams: TeamRecord[];
  members: GroupMemberRecord[];
};

export {
  assertDatabaseEnabled,
  getOrganisationMember,
  resolveOrganisationByDomain,
  toListLimit,
  isP2002Error,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
};

export function parseMaxGroupsPerOrg(config: ClientConfig): number {
  return config.org_features?.max_groups_per_org ?? 20;
}

export function parseMaxMembersPerGroup(config: ClientConfig): number {
  return config.org_features?.max_members_per_group ?? 500;
}

export function parseBooleanFlag(value: unknown): boolean {
  return value === true;
}

export function normalizeGroupName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) throw new AppError('BAD_REQUEST', 400);
  return trimmed;
}

export function normalizeGroupDescription(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed.length > 500) throw new AppError('BAD_REQUEST', 400);
  return trimmed === '' ? null : trimmed;
}

export function assertGroupFeaturesEnabled(config: ClientConfig): void {
  const orgFeatures = config.org_features;
  if (!orgFeatures?.enabled || !orgFeatures.groups_enabled) {
    throw new AppError('NOT_FOUND', 404);
  }
}

export function toGroupRecord(row: {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}): GroupRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toGroupMemberRecord(row: {
  id: string;
  groupId: string;
  userId: string;
  isAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}): GroupMemberRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    userId: row.userId,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
