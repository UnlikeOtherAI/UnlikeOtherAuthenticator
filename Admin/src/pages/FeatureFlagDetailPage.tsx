import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ActionButton } from '../components/ui/ActionButton';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { SelectField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { Switch } from '../components/ui/Switch';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { SegmentedTabs } from '../components/ui/Tabs';
import { useSettingsQuery, useUsersQuery } from '../features/admin/admin-queries';
import type { AppFlagSummary, FeatureAudienceGroup, FeatureFlagDefinition, KillSwitchEntry, UserSummary } from '../features/admin/types';
import { useAdminUi } from '../features/shell/admin-ui';
import { useCookieState } from '../utils/cookie-state';

const appDetailTabs = ['flags', 'killswitches', 'groups'] as const;

type AppDetailTab = (typeof appDetailTabs)[number];

export function FeatureFlagDetailPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useSettingsQuery();
  const { data: users = [] } = useUsersQuery();
  const { confirm, openDialog } = useAdminUi();
  const app = data?.apps.find((item) => item.id === appId);
  const [selectedPlatformId, setSelectedPlatformId] = useState('general');
  const [tab, setTab] = useCookieState<AppDetailTab>(`uoa-admin-feature-flags-tab-${appId ?? 'unknown'}`, 'flags', appDetailTabs);

  const visibleFlags = useMemo(() => {
    if (!app) {
      return [];
    }

    return app.flagDefinitions.filter((flag) => flag.platformMode === 'all' || flag.platformIds.includes(selectedPlatformId));
  }, [app, selectedPlatformId]);

  const visibleKillSwitches = useMemo(() => {
    if (!app || selectedPlatformId === 'general') {
      return app?.killSwitches ?? [];
    }

    const selectedPlatform = app.platforms.find((platform) => platform.id === selectedPlatformId);
    if (!selectedPlatform || (selectedPlatform.kind !== 'ios' && selectedPlatform.kind !== 'android')) {
      return [];
    }

    return app.killSwitches.filter((killSwitch) => killSwitch.platform === selectedPlatform.kind || killSwitch.platform === 'both');
  }, [app, selectedPlatformId]);

  const visibleGroups = useMemo(() => {
    if (!app || selectedPlatformId === 'general') {
      return app?.audienceGroups ?? [];
    }

    return app.audienceGroups.filter((group) => group.platformMode === 'all' || group.platformIds.includes(selectedPlatformId));
  }, [app, selectedPlatformId]);

  const { pageItems: flagPageItems, pagination: flagPagination } = usePagination(visibleFlags);
  const { pageItems: killSwitchPageItems, pagination: killSwitchPagination } = usePagination(visibleKillSwitches);
  const { pageItems: groupPageItems, pagination: groupPagination } = usePagination(visibleGroups);

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading feature flags...</p>;
  }

  if (!app) {
    return <p className="text-sm text-gray-400">App not found.</p>;
  }

  const selectedPlatform = app.platforms.find((platform) => platform.id === selectedPlatformId) ?? app.platforms[0];

  return (
    <>
      <Button className="mb-4" icon="back" onClick={() => navigate('/feature-flags')}>Back</Button>
      <PageHeader
        title={app.name}
        description={`${app.identifier} · ${app.domain} · ${app.org}`}
        actions={<Button icon="plus" variant="primary" onClick={() => openDialog({ type: 'register-platform', app })}>Add Platform</Button>}
      />
      <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_auto]">
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="block w-72 max-w-full">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">Platform</span>
              <SelectField className="w-full" value={selectedPlatform?.id ?? 'general'} onChange={(event) => setSelectedPlatformId(event.target.value)}>
                {app.platforms.map((platform) => (
                  <option key={platform.id} value={platform.id}>{platform.name}</option>
                ))}
              </SelectField>
            </label>
            <div className="flex flex-wrap gap-2 pt-6">
              {app.platforms.map((platform) => (
                <Badge key={platform.id} variant={platform.id === selectedPlatformId ? 'blue' : 'slate'}>{platform.name}</Badge>
              ))}
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex gap-5">
            <Metric label="Flags" value={String(app.flagDefinitions.length)} />
            <Metric label="Kill Switches" value={String(app.killSwitches.length)} />
            <Metric label="Groups" value={String(app.audienceGroups.length)} />
            <Metric label="Poll" value={`${app.pollIntervalSeconds}s`} />
          </div>
        </Card>
      </div>
      <SegmentedTabs<AppDetailTab> value={tab} onChange={setTab} options={[{ label: 'Feature Flags', value: 'flags' }, { label: 'Kill Switches', value: 'killswitches' }, { label: 'Groups', value: 'groups' }]} />
      {tab === 'flags' ? (
        <Card>
          <CardHeader>
            <div>
              <span className="text-sm font-semibold text-gray-900">Feature Flags</span>
              <p className="mt-0.5 text-xs text-gray-400">{selectedPlatform?.name ?? 'All platforms'}</p>
            </div>
            <Button icon="plus" size="sm" variant="primary" onClick={() => openDialog({ type: 'add-feature-flag', app })}>Add Flag</Button>
          </CardHeader>
          <DataTable headers={['Flag', 'Default', 'Scope', 'Platforms', 'Updated', 'Actions']}>
            {flagPageItems.map((flag) => (
              <tr
                key={flag.id}
                className="cursor-pointer transition-colors hover:bg-gray-50"
                tabIndex={0}
                onClick={() => openDialog({ type: 'edit-feature-flag', app, flag })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    openDialog({ type: 'edit-feature-flag', app, flag });
                  }
                }}
              >
                <Td>
                  <code className="font-semibold text-gray-900">{flag.key}</code>
                  <p className="mt-0.5 text-xs text-gray-400">{flag.description}</p>
                </Td>
                <Td onClick={(event) => event.stopPropagation()}>
                  <Switch checked={flag.defaultState} label={flag.defaultState ? 'Enabled' : 'Disabled'} onClick={() => confirm(`${flag.defaultState ? 'Disable' : 'Enable'} ${flag.key}?`, 'This changes the mocked flag default.')} />
                </Td>
                <Td><Badge variant={flag.platformMode === 'all' ? 'green' : 'blue'}>{flag.platformMode === 'all' ? 'All platforms' : 'Selected'}</Badge></Td>
                <Td className="text-xs text-gray-500">{platformNames(app, flag)}</Td>
                <Td className="text-xs text-gray-400">{flag.updated}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton tone="red" onClick={() => confirm(`Delete ${flag.key}?`, 'Deletes the mocked flag definition and assignments.')}>Delete</ActionButton>
                </Td>
              </tr>
            ))}
          </DataTable>
          <PaginationFooter {...flagPagination} />
        </Card>
      ) : null}
      {tab === 'killswitches' ? (
        <Card>
          <CardHeader>
            <div>
              <span className="text-sm font-semibold text-gray-900">Kill Switches</span>
              <p className="mt-0.5 text-xs text-gray-400">Version entries for mobile SDK startup checks</p>
            </div>
            <Button icon="plus" size="sm" variant="danger" onClick={() => openDialog({ type: 'add-kill-switch', app })}>Add Kill Switch</Button>
          </CardHeader>
          <DataTable headers={['Name', 'Platform', 'Type', 'Version Match', 'Latest', 'Users', 'Status', 'Priority', 'Actions']}>
            {killSwitchPageItems.map((killSwitch) => (
              <tr
                key={killSwitch.id}
                className="cursor-pointer transition-colors hover:bg-gray-50"
                tabIndex={0}
                onClick={() => openDialog({ type: 'edit-kill-switch', app, killSwitch })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    openDialog({ type: 'edit-kill-switch', app, killSwitch });
                  }
                }}
              >
                <Td>
                  <span className="font-semibold text-gray-900">{killSwitch.name}</span>
                  <p className="mt-0.5 text-xs text-gray-400">Cache {killSwitch.cacheTtl}s · {killSwitch.updated}</p>
                </Td>
                <Td><Badge variant="blue">{killSwitch.platform}</Badge></Td>
                <Td><Badge variant={killSwitch.type === 'hard' || killSwitch.type === 'maintenance' ? 'red' : 'amber'}>{killSwitch.type}</Badge></Td>
                <Td className="text-xs text-gray-500">{versionMatch(killSwitch)}</Td>
                <Td className="text-xs text-gray-500">{killSwitch.latestVersion ?? '-'}</Td>
                <Td className="text-xs text-gray-500">{killSwitchAudienceSummary(app, killSwitch, users)}</Td>
                <Td onClick={(event) => event.stopPropagation()}>
                  <Switch checked={killSwitch.active} label={killSwitch.active ? 'Active' : 'Paused'} tone="danger" onClick={() => confirm(`${killSwitch.active ? 'Pause' : 'Activate'} ${killSwitch.name}?`, 'This only updates the mocked kill switch status.')} />
                </Td>
                <Td>{killSwitch.priority}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton tone="red" onClick={() => confirm(`Delete ${killSwitch.name}?`, 'Deletes this mocked version rule.')}>Delete</ActionButton>
                </Td>
              </tr>
            ))}
          </DataTable>
          <PaginationFooter {...killSwitchPagination} />
        </Card>
      ) : null}
      {tab === 'groups' ? (
        <Card>
          <CardHeader>
            <div>
              <span className="text-sm font-semibold text-gray-900">Groups</span>
              <p className="mt-0.5 text-xs text-gray-400">{selectedPlatform?.name ?? 'All platforms'}</p>
            </div>
            <Button icon="plus" size="sm" variant="primary" onClick={() => openDialog({ type: 'add-audience-group', app, users })}>Add Group</Button>
          </CardHeader>
          <DataTable headers={['Group', 'Users', 'Platforms', 'Feature Flags', 'Kill Switches', 'Status', 'Updated', 'Actions']}>
            {groupPageItems.map((group) => (
              <tr
                key={group.id}
                className="cursor-pointer transition-colors hover:bg-gray-50"
                tabIndex={0}
                onClick={() => openDialog({ type: 'edit-audience-group', app, group, users })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    openDialog({ type: 'edit-audience-group', app, group, users });
                  }
                }}
              >
                <Td>
                  <span className="font-semibold text-gray-900">{group.name}</span>
                  <p className="mt-0.5 text-xs text-gray-400">{group.description}</p>
                </Td>
                <Td className="text-xs text-gray-500">{groupUserSummary(app, group, users)}</Td>
                <Td className="text-xs text-gray-500">{platformCoverage(app, group.platformMode, group.platformIds)}</Td>
                <Td className="text-xs text-gray-500">{featureFlagNames(app, group)}</Td>
                <Td className="text-xs text-gray-500">{killSwitchNames(app, group)}</Td>
                <Td><Badge variant={group.active ? 'green' : 'slate'}>{group.active ? 'Active' : 'Paused'}</Badge></Td>
                <Td className="text-xs text-gray-400">{group.updated}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton tone="red" onClick={() => confirm(`Delete ${group.name}?`, 'Deletes this mocked audience group.')}>Delete</ActionButton>
                </Td>
              </tr>
            ))}
          </DataTable>
          <PaginationFooter {...groupPagination} />
        </Card>
      ) : null}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function platformNames(app: AppFlagSummary, flag: FeatureFlagDefinition) {
  if (flag.platformMode === 'all') {
    return 'All platforms';
  }

  return flag.platformIds
    .map((platformId) => app.platforms.find((platform) => platform.id === platformId)?.name)
    .filter(Boolean)
    .join(', ');
}

function platformCoverage(app: AppFlagSummary, platformMode: FeatureAudienceGroup['platformMode'], platformIds: string[]) {
  if (platformMode === 'all') {
    return 'All platforms';
  }

  return platformIds
    .map((platformId) => app.platforms.find((platform) => platform.id === platformId)?.name)
    .filter(Boolean)
    .join(', ');
}

function groupUserSummary(app: AppFlagSummary, group: FeatureAudienceGroup, users: UserSummary[]) {
  const targetUsers = usersForGroup(app, group, users);

  if (group.userMode === 'all') {
    return `All eligible users (${targetUsers.length})`;
  }

  return `${userPreview(targetUsers)} (${targetUsers.length})`;
}

function killSwitchAudienceSummary(app: AppFlagSummary, killSwitch: KillSwitchEntry, users: UserSummary[]) {
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

function featureFlagNames(app: AppFlagSummary, group: FeatureAudienceGroup) {
  const names = group.featureFlagIds
    .map((flagId) => app.flagDefinitions.find((flag) => flag.id === flagId)?.key)
    .filter(Boolean);

  return names.length > 0 ? names.join(', ') : '-';
}

function killSwitchNames(app: AppFlagSummary, group: FeatureAudienceGroup) {
  const names = group.killSwitchIds
    .map((killSwitchId) => app.killSwitches.find((killSwitch) => killSwitch.id === killSwitchId)?.name)
    .filter(Boolean);

  return names.length > 0 ? names.join(', ') : '-';
}

function usersForGroup(app: AppFlagSummary, group: FeatureAudienceGroup, users: UserSummary[]) {
  if (group.userMode === 'all') {
    return eligibleUsers(app, users);
  }

  const selectedUserIds = new Set(group.userIds);
  return users.filter((user) => selectedUserIds.has(user.id));
}

function eligibleUsers(app: AppFlagSummary, users: UserSummary[]) {
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

function versionMatch(killSwitch: KillSwitchEntry) {
  if (killSwitch.operator === 'range') {
    return `${killSwitch.versionField} ${killSwitch.versionValue} - ${killSwitch.versionMax ?? '?'}`;
  }

  return `${killSwitch.versionField} ${killSwitch.operator} ${killSwitch.versionValue}`;
}
