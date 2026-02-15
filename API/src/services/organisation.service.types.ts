export interface OrgLimits {
  maxTeamsPerOrg: number;
  maxMembersPerOrg: number;
  maxTeamMembershipsPerUser: number;
}

export interface CreateOrganisationInput {
  domain: string;
  name: string;
  ownerUserId: string;
  ownerRole: string;
  allowedRoles: string[];
  limits: OrgLimits;
}

export interface GetOrganisationInput {
  orgId: string;
  domain: string;
}

export interface ListOrganisationsInput {
  domain: string;
  limit?: number;
  cursor?: string;
}

export interface UpdateOrganisationInput {
  orgId: string;
  domain: string;
  name: string;
  callerUserId: string;
}

export interface DeleteOrganisationInput {
  orgId: string;
  domain: string;
  callerUserId: string;
}

export interface TransferOwnershipInput {
  orgId: string;
  domain: string;
  newOwnerUserId: string;
  callerUserId: string;
  allowedRoles: string[];
}

export interface ListOrgMembersInput {
  orgId: string;
  domain: string;
  limit?: number;
  cursor?: string;
}

export interface AddOrgMemberInput {
  orgId: string;
  domain: string;
  userId: string;
  role: string;
  callerUserId: string;
  limits: Pick<OrgLimits, 'maxMembersPerOrg'>;
}

export interface UpdateOrgMemberRoleInput {
  orgId: string;
  domain: string;
  userId: string;
  role: string;
  callerUserId: string;
  allowedRoles: string[];
}

export interface RemoveOrgMemberInput {
  orgId: string;
  domain: string;
  userId: string;
  callerUserId: string;
}

export interface PaginationResult<T> {
  data: T[];
  nextCursor: string | null;
}

export type OrganisationServiceErrorCode =
  | 'VALIDATION_ERROR'
  | 'ORG_NOT_FOUND'
  | 'NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'MEMBER_NOT_FOUND'
  | 'CONFLICT'
  | 'LAST_OWNER'
  | 'UNAUTHORIZED';

export class OrganisationServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: OrganisationServiceErrorCode;

  constructor(code: OrganisationServiceErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'OrganisationServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface OrgMemberRecord {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}
