export type AuthMethod = 'email' | 'google' | 'github' | 'apple' | 'facebook' | 'linkedin' | 'microsoft';

export type EntityStatus = 'active' | 'disabled' | 'banned';

export type UoaRole = 'owner' | 'admin' | 'member';

export type TeamRole = 'admin' | 'member';

export type Domain = {
  id: string;
  name: string;
  label: string;
  secretAge: string | null;
  secretOld: boolean;
  users: number;
  orgs: number;
  status: EntityStatus;
  created: string;
  hash: string;
};

export type Team = {
  id: string;
  orgId: string;
  name: string;
  description: string;
  isDefault: boolean;
  members: number;
};

export type UserSummary = {
  id: string;
  name: string | null;
  email: string;
  domains: string[];
  twofa: boolean;
  lastLogin: string;
  status: EntityStatus;
  method: AuthMethod;
  created: string;
};

export type OrganisationMember = Omit<UserSummary, 'domains' | 'created'> & {
  role: UoaRole;
  teams: string[];
  teamRoles: Record<string, TeamRole>;
};

export type Organisation = {
  id: string;
  name: string;
  slug: string;
  created: string;
  owner: Pick<UserSummary, 'id' | 'name' | 'email'>;
  teams: Team[];
  members: OrganisationMember[];
};

export type LoginLog = {
  id: string;
  ts: string;
  user: string | null;
  domain: string;
  method: AuthMethod;
  ip: string;
  userAgent: string;
  result: 'ok' | 'fail';
};

export type BanRecord = {
  id: string;
  value: string;
  label?: string;
  bannedAt: string;
  reason?: string;
  hits?: number;
  expiry?: string | null;
};

export type AppFlagSummary = {
  id: string;
  name: string;
  domain: string;
  org: string;
  flagsEnabled: boolean;
  matrixEnabled: boolean;
  flags: number;
  status: EntityStatus;
};

export type AdminData = {
  stats: {
    users: number;
    domains: number;
    orgs: number;
    loginsToday: number;
  };
  domains: Domain[];
  organisations: Organisation[];
  users: UserSummary[];
  logs: LoginLog[];
  bans: {
    emails: BanRecord[];
    patterns: BanRecord[];
    ips: BanRecord[];
    users: BanRecord[];
  };
  apps: AppFlagSummary[];
};

export type SearchResult =
  | { type: 'organisation'; organisation: Organisation }
  | { type: 'team'; organisation: Organisation; team: Team }
  | { type: 'user'; user: UserSummary };
