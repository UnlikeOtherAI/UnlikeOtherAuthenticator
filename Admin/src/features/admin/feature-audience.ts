import { ALL_PLATFORMS_ID, isAllPlatformsSelection, platformNames } from './platforms';
import type { AppFlagSummary, FeatureAudienceGroup, FeatureFlagDefinition, KillSwitchEntry, UserSummary } from './types';

export function platformCoverage(app: AppFlagSummary, platformMode: FeatureAudienceGroup['platformMode'], platformIds: string[]) {
  if (platformMode === 'all') {
    return 'All platforms';
  }

  return platformNames(app, platformIds);
}

export function appliesToPlatform(platformMode: 'all' | 'selected', platformIds: string[], selectedPlatformId: string) {
  return isAllPlatformsSelection(selectedPlatformId) || platformMode === 'all' || platformIds.includes(selectedPlatformId);
}

export function filterFlagsByPlatform(flags: FeatureFlagDefinition[], selectedPlatformId: string) {
  if (isAllPlatformsSelection(selectedPlatformId)) {
    return flags;
  }

  return flags.filter((flag) => appliesToPlatform(flag.platformMode, flag.platformIds, selectedPlatformId));
}

export function filterKillSwitchesByPlatform(killSwitches: KillSwitchEntry[], selectedPlatformId: string) {
  if (isAllPlatformsSelection(selectedPlatformId)) {
    return killSwitches;
  }

  return killSwitches.filter((killSwitch) => appliesToPlatform(killSwitch.platformMode, killSwitch.platformIds, selectedPlatformId));
}

export function filterGroupsByPlatform(groups: FeatureAudienceGroup[], selectedPlatformId: string) {
  if (isAllPlatformsSelection(selectedPlatformId)) {
    return groups;
  }

  return groups.filter((group) => appliesToPlatform(group.platformMode, group.platformIds, selectedPlatformId));
}

export function killSwitchPlatformLabel(app: AppFlagSummary, killSwitch: KillSwitchEntry) {
  if (killSwitch.platformMode === 'all') {
    return 'All platforms';
  }

  return platformNames(app, killSwitch.platformIds);
}

export function defaultSelectedPlatformId() {
  return ALL_PLATFORMS_ID;
}

export function groupUserSummary(app: AppFlagSummary, group: FeatureAudienceGroup, users: UserSummary[]) {
  const targetUsers = usersForGroup(app, group, users);

  if (group.userMode === 'all') {
    return `All eligible users (${targetUsers.length})`;
  }

  return `${userPreview(targetUsers)} (${targetUsers.length})`;
}

export function killSwitchAudienceSummary(app: AppFlagSummary, killSwitch: KillSwitchEntry, users: UserSummary[]) {
  const groups = app.audienceGroups.filter((group) => group.killSwitchIds.includes(killSwitch.id));

  if (groups.length === 0) {
    return 'No group';
  }

  const hasAllUsersGroup = groups.some((group) => group.userMode === 'all');
  const targetUsers = uniqueUsers(groups.flatMap((group) => usersForGroup(app, group, users)));

  if (hasAllUsersGroup) {
    return `All eligible users (${targetUsers.length})`;
  }

  return `${userPreview(targetUsers)} (${targetUsers.length})`;
}

export function featureFlagNames(app: AppFlagSummary, group: FeatureAudienceGroup) {
  const names = group.featureFlagIds
    .map((flagId) => app.flagDefinitions.find((flag) => flag.id === flagId)?.key)
    .filter(Boolean);

  return names.length > 0 ? names.join(', ') : '-';
}

export function featureFlagPlatformLabel(app: AppFlagSummary, flag: FeatureFlagDefinition) {
  if (flag.platformMode === 'all') {
    return 'All platforms';
  }

  return platformNames(app, flag.platformIds);
}

export function killSwitchNames(app: AppFlagSummary, group: FeatureAudienceGroup) {
  const names = group.killSwitchIds
    .map((killSwitchId) => app.killSwitches.find((killSwitch) => killSwitch.id === killSwitchId)?.name)
    .filter(Boolean);

  return names.length > 0 ? names.join(', ') : '-';
}

export function usersForGroup(app: AppFlagSummary, group: FeatureAudienceGroup, users: UserSummary[]) {
  if (group.userMode === 'all') {
    return eligibleUsers(app, users);
  }

  const selectedUserIds = new Set(group.userIds);
  return users.filter((user) => selectedUserIds.has(user.id));
}

export function eligibleUsers(app: AppFlagSummary, users: UserSummary[]) {
  const appDomains = new Set(app.domains);
  return users.filter((user) => user.domains.some((domain) => appDomains.has(domain)));
}

function uniqueUsers(users: UserSummary[]) {
  return Array.from(new Map(users.map((user) => [user.id, user])).values());
}

function userPreview(users: UserSummary[]) {
  if (users.length === 0) {
    return 'No users';
  }

  const preview = users.slice(0, 2).map((user) => user.name ?? user.email).join(', ');
  const remaining = users.length - 2;

  return remaining > 0 ? `${preview}, +${remaining}` : preview;
}
