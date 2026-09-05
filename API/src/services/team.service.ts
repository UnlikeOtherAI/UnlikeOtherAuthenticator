export type {
  CursorList,
  TeamJoinPolicyValue,
  TeamMemberRecord,
  TeamRecord,
  TeamWithMembersRecord,
} from './team.service.base.js';

export { listTeams, createTeam, getTeam, updateTeam, deleteTeam } from './team.service.teams.js';

export {
  addTeamMember,
  changeTeamMemberRole,
  removeTeamMember,
  selfJoinTeam,
} from './team.service.members.js';

export { findTeamMemberCandidates, listTeamMembers } from './team.service.roster.js';
export {
  listMemberTeamAccess,
  type MemberTeamAccess,
  type MemberTeamAccessResult,
} from './member-team-access.service.js';

export type {
  TeamMemberCandidate,
  TeamRosterMember,
  TeamRosterPage,
  TeamRosterPermissions,
} from './team.service.roster.js';
