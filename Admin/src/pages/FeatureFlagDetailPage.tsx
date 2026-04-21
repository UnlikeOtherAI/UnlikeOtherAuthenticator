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
import {
  defaultSelectedPlatformId,
  featureFlagNames,
  featureFlagPlatformLabel,
  filterFlagsByPlatform,
  filterGroupsByPlatform,
  filterKillSwitchesByPlatform,
  groupUserSummary,
  killSwitchAudienceSummary,
  killSwitchNames,
  killSwitchPlatformLabel,
  platformCoverage,
} from '../features/admin/feature-audience';
import { useSettingsQuery, useUsersQuery } from '../features/admin/admin-queries';
import { ALL_PLATFORMS_ID } from '../features/admin/platforms';
import type { KillSwitchEntry } from '../features/admin/types';
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
  const [selectedPlatformId, setSelectedPlatformId] = useState(defaultSelectedPlatformId);
  const [tab, setTab] = useCookieState<AppDetailTab>(`uoa-admin-feature-flags-tab-${appId ?? 'unknown'}`, 'flags', appDetailTabs);

  const visibleFlags = useMemo(() => {
    if (!app) {
      return [];
    }

    return filterFlagsByPlatform(app.flagDefinitions, selectedPlatformId);
  }, [app, selectedPlatformId]);

  const visibleKillSwitches = useMemo(() => {
    if (!app) {
      return [];
    }

    return filterKillSwitchesByPlatform(app.killSwitches, selectedPlatformId);
  }, [app, selectedPlatformId]);

  const visibleGroups = useMemo(() => {
    if (!app) {
      return [];
    }

    return filterGroupsByPlatform(app.audienceGroups, selectedPlatformId);
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

  const selectedPlatform = app.platforms.find((platform) => platform.id === selectedPlatformId);
  const selectedPlatformName = selectedPlatform?.name ?? 'All platforms';

  return (
    <>
      <PageHeader
        title={app.name}
        description={`${app.identifier} · ${app.domain} · ${app.org}`}
        onBack={() => navigate('/feature-flags')}
        actions={<Button icon="plus" variant="primary" onClick={() => openDialog({ type: 'register-platform', app })}>Add Platform</Button>}
      />
      <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_auto]">
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="block w-72 max-w-full">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">Platform</span>
              <SelectField className="w-full" value={selectedPlatformId} onChange={(event) => setSelectedPlatformId(event.target.value)}>
                <option value={ALL_PLATFORMS_ID}>All platforms</option>
                {app.platforms.map((platform) => (
                  <option key={platform.id} value={platform.id}>{platform.name}</option>
                ))}
              </SelectField>
            </label>
            <div aria-hidden="true" className="flex flex-wrap gap-2 pt-6">
              <Badge variant={selectedPlatformId === ALL_PLATFORMS_ID ? 'blue' : 'slate'}>All platforms</Badge>
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
              <p className="mt-0.5 text-xs text-gray-400">{selectedPlatformName}</p>
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
                <Td className="text-xs text-gray-500">{featureFlagPlatformLabel(app, flag)}</Td>
                <Td className="text-xs text-gray-400">{flag.updated}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton aria-label={`Delete ${flag.key}`} tone="red" onClick={() => confirm(`Delete ${flag.key}?`, 'Deletes the mocked flag definition and assignments.')}>Delete</ActionButton>
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
                <Td><Badge variant="blue">{killSwitchPlatformLabel(app, killSwitch)}</Badge></Td>
                <Td><Badge variant={killSwitch.type === 'hard' || killSwitch.type === 'maintenance' ? 'red' : 'amber'}>{killSwitch.type}</Badge></Td>
                <Td className="text-xs text-gray-500">{versionMatch(killSwitch)}</Td>
                <Td className="text-xs text-gray-500">{killSwitch.latestVersion ?? '-'}</Td>
                <Td className="text-xs text-gray-500">{killSwitchAudienceSummary(app, killSwitch, users)}</Td>
                <Td onClick={(event) => event.stopPropagation()}>
                  <Switch checked={killSwitch.active} label={killSwitch.active ? 'Active' : 'Paused'} tone="danger" onClick={() => confirm(`${killSwitch.active ? 'Pause' : 'Activate'} ${killSwitch.name}?`, 'This only updates the mocked kill switch status.')} />
                </Td>
                <Td>{killSwitch.priority}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton aria-label={`Delete ${killSwitch.name}`} tone="red" onClick={() => confirm(`Delete ${killSwitch.name}?`, 'Deletes this mocked version rule.')}>Delete</ActionButton>
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
              <p className="mt-0.5 text-xs text-gray-400">{selectedPlatformName}</p>
            </div>
            <Button icon="plus" size="sm" variant="primary" onClick={() => navigate(`/feature-flags/${app.id}/groups/new`)}>Add Group</Button>
          </CardHeader>
          <DataTable headers={['Group', 'Users', 'Platforms', 'Feature Flags', 'Kill Switches', 'Status', 'Updated', 'Actions']}>
            {groupPageItems.map((group) => (
              <tr
                key={group.id}
                className="cursor-pointer transition-colors hover:bg-gray-50"
                tabIndex={0}
                onClick={() => navigate(`/feature-flags/${app.id}/groups/${group.id}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    navigate(`/feature-flags/${app.id}/groups/${group.id}`);
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
                  <ActionButton aria-label={`Delete ${group.name}`} tone="red" onClick={() => confirm(`Delete ${group.name}?`, 'Deletes this mocked audience group.')}>Delete</ActionButton>
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

function versionMatch(killSwitch: KillSwitchEntry) {
  if (killSwitch.operator === 'range') {
    return `${killSwitch.versionField} ${killSwitch.versionValue} - ${killSwitch.versionMax ?? '?'}`;
  }

  return `${killSwitch.versionField} ${killSwitch.operator} ${killSwitch.versionValue}`;
}
