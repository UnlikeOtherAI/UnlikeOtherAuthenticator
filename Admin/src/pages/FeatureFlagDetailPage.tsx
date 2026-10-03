import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

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
  featureFlagPlatformLabel,
  filterFlagsByPlatform,
  filterKillSwitchesByPlatform,
  killSwitchPlatformLabel,
} from '../features/admin/feature-audience';
import { FeatureFlagDialog } from '../components/dialogs/FeatureFlagDialog';
import { KillSwitchDialog } from '../components/dialogs/KillSwitchDialog';
import {
  useDeleteFeatureFlagMutation,
  useDeleteKillSwitchMutation,
  useSettingsQuery,
  useUpdateFeatureFlagMutation,
  useUpdateKillSwitchMutation,
} from '../features/admin/admin-queries';
import { ALL_PLATFORMS_ID } from '../features/admin/platforms';
import type { FeatureFlagDefinition, KillSwitchEntry } from '../features/admin/types';
import { useAdminUi } from '../features/shell/admin-ui';

type DialogState =
  | { kind: 'add-feature-flag' }
  | { kind: 'edit-feature-flag'; flag: FeatureFlagDefinition }
  | { kind: 'add-kill-switch' }
  | { kind: 'edit-kill-switch'; killSwitch: KillSwitchEntry };

const appDetailTabs = ['flags', 'killswitches', 'settings'] as const;

type AppDetailTab = (typeof appDetailTabs)[number];

export function FeatureFlagDetailPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useSettingsQuery();
  const { confirm } = useAdminUi();
  const [localDialog, setLocalDialog] = useState<DialogState | null>(null);
  const [params, setParams] = useSearchParams();
  function changeParam(key: string, value?: string) {
    setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; });
  }
  const setDialog = setLocalDialog;
  const closeDialog = () => { setLocalDialog(null); setParams((current) => { const next = new URLSearchParams(current); next.delete('flag'); next.delete('rule'); return next; }); };

  const app = data?.apps.find((item) => item.id === appId);
  const resolvedAppId = app?.id ?? '';
  const flagDeleteMutation = useDeleteFeatureFlagMutation(resolvedAppId);
  const killSwitchDeleteMutation = useDeleteKillSwitchMutation(resolvedAppId);
  const requestedPlatform = params.get('platform');
  const selectedPlatformId = app?.platforms.some((platform) => platform.id === requestedPlatform) ? requestedPlatform! : ALL_PLATFORMS_ID;
  const setSelectedPlatformId = (next: string) => changeParam('platform', next);
  const tabParam = params.get('tab');
  const tab: AppDetailTab = appDetailTabs.includes(tabParam as AppDetailTab) ? tabParam as AppDetailTab : 'flags';
  const setTab = (next: AppDetailTab) => changeParam('tab', next);
  const selectedFlag = app?.flagDefinitions.find((flag) => flag.id === params.get('flag'));
  const selectedRule = app?.killSwitches.find((rule) => rule.id === params.get('rule'));
  const dialog: DialogState | null = selectedFlag ? { kind: 'edit-feature-flag', flag: selectedFlag } : selectedRule ? { kind: 'edit-kill-switch', killSwitch: selectedRule } : localDialog;

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

    return filterKillSwitchesByPlatform(app.killSwitches, app.platforms.find((platform) => platform.id === selectedPlatformId)?.key ?? selectedPlatformId);
  }, [app, selectedPlatformId]);

  const { pageItems: flagPageItems, pagination: flagPagination } = usePagination(visibleFlags);
  const { pageItems: killSwitchPageItems, pagination: killSwitchPagination } = usePagination(visibleKillSwitches);

  if (isError) return <p role="alert">Could not load feature flags. <Button onClick={() => refetch()}>Retry</Button></p>;

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
      />
      {tab !== 'settings' && app.platforms.length > 1 ? <div className="mb-4">
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
          </div>
        </Card>
      </div> : null}
      <SegmentedTabs<AppDetailTab> value={tab} onChange={setTab} options={[{ label: 'Feature Flags', value: 'flags' }, { label: 'Kill Switches', value: 'killswitches' }, { label: 'Settings', value: 'settings' }]} />
      {tab === 'flags' ? (
        <Card>
          <CardHeader>
            <div>
              <span className="text-sm font-semibold text-gray-900">Feature Flags</span>
              <p className="mt-0.5 text-xs text-gray-400">{selectedPlatformName}</p>
            </div>
            <Button icon="plus" size="sm" variant="primary" onClick={() => setDialog({ kind: 'add-feature-flag' })}>Add Flag</Button>
          </CardHeader>
          <DataTable headers={['Flag', 'Default', 'Platforms', 'Updated', 'Actions']}>
            {flagPageItems.map((flag) => (
              <tr
                key={flag.id}
                className="cursor-pointer transition-colors hover:bg-gray-50"
              >
                <Td>
                  <Link to={`?${new URLSearchParams({ ...Object.fromEntries(params), tab: 'flags', flag: flag.id })}`} className="font-semibold text-indigo-600 hover:underline">{flag.key}</Link>
                  <p className="mt-0.5 text-xs text-gray-400">{flag.description}</p>
                </Td>
                <Td onClick={(event) => event.stopPropagation()}>
                  <FlagDefaultSwitch appId={app.id} flag={flag} />
                </Td>
                <Td className="text-xs text-gray-500">{featureFlagPlatformLabel(app, flag)}</Td>
                <Td className="text-xs text-gray-400">{flag.updated}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton
                    aria-label={`Delete ${flag.key}`}
                    tone="red"
                    onClick={() =>
                      confirm(`Delete ${flag.key}?`, 'This removes the stored flag definition and related overrides.', async () => {
                        await flagDeleteMutation.mutateAsync(flag.id);
                      })
                    }
                  >
                    Delete
                  </ActionButton>
                </Td>
              </tr>
            ))}
            {!flagPageItems.length ? <tr><Td colSpan={5}>No feature flags match this view.</Td></tr> : null}
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
            <Button icon="plus" size="sm" variant="danger" onClick={() => setDialog({ kind: 'add-kill-switch' })}>Add Kill Switch</Button>
          </CardHeader>
          <DataTable headers={['Name', 'Platform', 'Type', 'Version Match', 'Latest', 'Status', 'Priority', 'Actions']}>
            {killSwitchPageItems.map((killSwitch) => (
              <tr
                key={killSwitch.id}
                className="cursor-pointer transition-colors hover:bg-gray-50"
              >
                <Td>
                  <Link to={`?${new URLSearchParams({ ...Object.fromEntries(params), tab: 'killswitches', rule: killSwitch.id })}`} className="font-semibold text-indigo-600 hover:underline">{killSwitch.name}</Link>
                  <p className="mt-0.5 text-xs text-gray-400">Cache {killSwitch.cacheTtl}s · {killSwitch.updated}</p>
                </Td>
                <Td><Badge variant="blue">{killSwitchPlatformLabel(app, killSwitch)}</Badge></Td>
                <Td><Badge variant={killSwitch.type === 'hard' || killSwitch.type === 'maintenance' ? 'red' : 'amber'}>{killSwitch.type}</Badge></Td>
                <Td className="text-xs text-gray-500">{versionMatch(killSwitch)}</Td>
                <Td className="text-xs text-gray-500">{killSwitch.latestVersion ?? '-'}</Td>
                <Td onClick={(event) => event.stopPropagation()}>
                  <KillSwitchActiveSwitch appId={app.id} killSwitch={killSwitch} />
                </Td>
                <Td>{killSwitch.priority}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton
                    aria-label={`Delete ${killSwitch.name}`}
                    tone="red"
                    onClick={() =>
                      confirm(`Delete ${killSwitch.name}?`, 'This removes the stored version rule.', async () => {
                        await killSwitchDeleteMutation.mutateAsync(killSwitch.id);
                      })
                    }
                  >
                    Delete
                  </ActionButton>
                </Td>
              </tr>
            ))}
            {!killSwitchPageItems.length ? <tr><Td colSpan={8}>No kill switches match this view.</Td></tr> : null}
          </DataTable>
          <PaginationFooter {...killSwitchPagination} />
        </Card>
      ) : null}
      {tab === 'settings' ? <Card className="space-y-3 p-5"><h2 className="font-semibold">App settings</h2><dl className="space-y-2 text-sm"><div><dt className="text-gray-500">Identifier</dt><dd>{app.identifier}</dd></div><div><dt className="text-gray-500">Poll interval</dt><dd>{app.pollIntervalSeconds} seconds</dd></div><div><dt className="text-gray-500">Platform</dt><dd>{app.platform}</dd></div></dl><p className="text-sm text-gray-500">Registration settings are read-only. Audience groups and additional platform registration are not available.</p></Card> : null}
      <FeatureFlagDialog
        open={dialog?.kind === 'add-feature-flag' || dialog?.kind === 'edit-feature-flag'}
        app={app}
        flag={dialog?.kind === 'edit-feature-flag' ? dialog.flag : null}
        onClose={closeDialog}
      />
      <KillSwitchDialog
        open={dialog?.kind === 'add-kill-switch' || dialog?.kind === 'edit-kill-switch'}
        app={app}
        killSwitch={dialog?.kind === 'edit-kill-switch' ? dialog.killSwitch : null}
        onClose={closeDialog}
      />
    </>
  );
}

function FlagDefaultSwitch({ appId, flag }: { appId: string; flag: FeatureFlagDefinition }) {
  const { confirm } = useAdminUi();
  const mutation = useUpdateFeatureFlagMutation(appId, flag.id);

  return (
    <Switch
      checked={flag.defaultState}
      label={flag.defaultState ? 'Enabled' : 'Disabled'}
      onClick={() =>
        confirm(`${flag.defaultState ? 'Disable' : 'Enable'} ${flag.key}?`, 'This changes the stored default flag state.', async () => {
          await mutation.mutateAsync({
            key: flag.key,
            description: flag.description,
            defaultState: !flag.defaultState,
          });
        })
      }
    />
  );
}

function KillSwitchActiveSwitch({ appId, killSwitch }: { appId: string; killSwitch: KillSwitchEntry }) {
  const { confirm } = useAdminUi();
  const mutation = useUpdateKillSwitchMutation(appId, killSwitch.id);

  return (
    <Switch
      checked={killSwitch.active}
      label={killSwitch.active ? 'Active' : 'Paused'}
      tone="danger"
      onClick={() =>
        confirm(`${killSwitch.active ? 'Pause' : 'Activate'} ${killSwitch.name}?`, 'This changes the stored kill switch status.', async () => {
          await mutation.mutateAsync({
            name: killSwitch.name,
            platform: killSwitch.platformMode === 'selected' ? killSwitch.platformIds[0] ?? 'both' : 'both',
            type: killSwitch.type,
            versionField: killSwitch.versionField,
            operator: killSwitch.operator,
            versionValue: killSwitch.versionValue,
            versionMax: killSwitch.versionMax,
            versionScheme: killSwitch.versionScheme,
            latestVersion: killSwitch.latestVersion,
            active: !killSwitch.active,
            priority: killSwitch.priority,
            cacheTtl: killSwitch.cacheTtl,
          });
        })
      }
    />
  );
}

function versionMatch(killSwitch: KillSwitchEntry) {
  if (killSwitch.operator === 'range') {
    return `${killSwitch.versionField} ${killSwitch.versionValue} - ${killSwitch.versionMax ?? '?'}`;
  }

  return `${killSwitch.versionField} ${killSwitch.operator} ${killSwitch.versionValue}`;
}
