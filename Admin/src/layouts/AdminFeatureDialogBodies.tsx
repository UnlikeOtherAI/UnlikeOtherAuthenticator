import { useMemo, useState, type ReactNode } from 'react';

import { FieldShell, SelectField, TextAreaField, TextField } from '../components/ui/FormFields';
import type { AppFlagSummary, FeatureAudienceGroup, FeatureFlagDefinition, KillSwitchEntry, UserSummary } from '../features/admin/types';

type FeatureFlagDialogBodyProps = {
  app: AppFlagSummary;
  flag: FeatureFlagDefinition | null;
};

type KillSwitchDialogBodyProps = {
  app: AppFlagSummary;
  killSwitch: KillSwitchEntry | null;
};

type AudienceGroupDialogBodyProps = {
  app: AppFlagSummary;
  group: FeatureAudienceGroup | null;
  users: UserSummary[];
};

export function FeatureFlagDialogBody({ app, flag }: FeatureFlagDialogBodyProps) {
  const selectedPlatformIds = new Set(flag?.platformIds ?? app.platforms.map((platform) => platform.id));
  const selectedGroupIds = new Set(flag ? app.audienceGroups.filter((group) => group.featureFlagIds.includes(flag.id)).map((group) => group.id) : []);

  return (
    <div className="space-y-4">
      <FieldShell label="Flag key">
        <TextField className="font-mono" defaultValue={flag?.key ?? ''} placeholder="new_checkout" />
      </FieldShell>
      <FieldShell label="Description">
        <TextField defaultValue={flag?.description ?? ''} placeholder="New checkout flow" />
      </FieldShell>
      <FieldShell label="Default state">
        <SelectField defaultValue={flag?.defaultState ? 'enabled' : 'disabled'}>
          <option value="disabled">Disabled</option>
          <option value="enabled">Enabled</option>
        </SelectField>
      </FieldShell>
      <FieldShell label="Platform coverage">
        <SelectField defaultValue={flag?.platformMode ?? 'all'}>
          <option value="all">All platforms</option>
          <option value="selected">Selected platforms</option>
        </SelectField>
      </FieldShell>
      <CheckboxGrid title="Platforms">
        {app.platforms.map((platform) => (
          <CheckboxRow key={platform.id} label={platform.name} defaultChecked={platform.kind === 'general' || selectedPlatformIds.has(platform.id)} disabled={platform.kind === 'general'} />
        ))}
      </CheckboxGrid>
      <CheckboxGrid title="Audience groups">
        {app.audienceGroups.map((group) => (
          <CheckboxRow key={group.id} label={group.name} defaultChecked={selectedGroupIds.has(group.id)} />
        ))}
      </CheckboxGrid>
    </div>
  );
}

export function KillSwitchDialogBody({ app, killSwitch }: KillSwitchDialogBodyProps) {
  const selectedGroupIds = new Set(killSwitch ? app.audienceGroups.filter((group) => group.killSwitchIds.includes(killSwitch.id)).map((group) => group.id) : []);

  return (
    <div className="space-y-4">
      <FieldShell label="Rule name">
        <TextField defaultValue={killSwitch?.name ?? ''} placeholder="Block legacy iOS builds" />
      </FieldShell>
      <FieldShell label="Platform">
        <SelectField defaultValue={killSwitch?.platform ?? 'ios'}>
          <option value="ios">iOS</option>
          <option value="android">Android</option>
          <option value="both">iOS + Android</option>
        </SelectField>
      </FieldShell>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldShell label="Type">
          <SelectField defaultValue={killSwitch?.type ?? 'hard'}>
            <option value="hard">Hard block</option>
            <option value="soft">Soft warning</option>
            <option value="info">Info</option>
            <option value="maintenance">Maintenance</option>
          </SelectField>
        </FieldShell>
        <FieldShell label="Version field">
          <SelectField defaultValue={killSwitch?.versionField ?? 'versionName'}>
            <option value="versionName">versionName</option>
            <option value="versionCode">versionCode</option>
            <option value="buildNumber">buildNumber</option>
          </SelectField>
        </FieldShell>
        <FieldShell label="Operator">
          <SelectField defaultValue={killSwitch?.operator ?? 'lt'}>
            <option value="lt">Less than</option>
            <option value="lte">Less than or equal</option>
            <option value="eq">Equals</option>
            <option value="gte">Greater than or equal</option>
            <option value="gt">Greater than</option>
            <option value="range">Range</option>
          </SelectField>
        </FieldShell>
        <FieldShell label="Version scheme">
          <SelectField defaultValue={killSwitch?.versionScheme ?? 'semver'}>
            <option value="semver">semver</option>
            <option value="integer">integer</option>
            <option value="date">date</option>
            <option value="custom">custom</option>
          </SelectField>
        </FieldShell>
        <FieldShell label="Minimum / value">
          <TextField defaultValue={killSwitch?.versionValue ?? ''} placeholder="2.1.0" />
        </FieldShell>
        <FieldShell label="Maximum">
          <TextField defaultValue={killSwitch?.versionMax ?? ''} placeholder="Only for ranges" />
        </FieldShell>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldShell label="Latest version">
          <TextField defaultValue={killSwitch?.latestVersion ?? ''} placeholder="2.1.0" />
        </FieldShell>
        <FieldShell label="Priority">
          <TextField defaultValue={String(killSwitch?.priority ?? 0)} type="number" />
        </FieldShell>
      </div>
      <CheckboxGrid title="Audience groups">
        {app.audienceGroups.map((group) => (
          <CheckboxRow key={group.id} label={group.name} defaultChecked={selectedGroupIds.has(group.id)} />
        ))}
      </CheckboxGrid>
    </div>
  );
}

export function AudienceGroupDialogBody({ app, group, users }: AudienceGroupDialogBodyProps) {
  const eligibleUsers = useMemo(() => users.filter((user) => user.domains.some((domain) => app.domains.includes(domain))), [app.domains, users]);
  const selectableUsers = eligibleUsers.length > 0 ? eligibleUsers : users;
  const selectedUserIds = new Set(group?.userIds ?? []);
  const selectedPlatformIds = new Set(group?.platformIds ?? app.platforms.map((platform) => platform.id));
  const selectedFlagIds = new Set(group?.featureFlagIds ?? []);
  const selectedKillSwitchIds = new Set(group?.killSwitchIds ?? []);
  const [userMode, setUserMode] = useState<FeatureAudienceGroup['userMode']>(group?.userMode ?? 'selected');
  const [platformMode, setPlatformMode] = useState<FeatureAudienceGroup['platformMode']>(group?.platformMode ?? 'all');

  return (
    <div className="space-y-4">
      <FieldShell label="Group name">
        <TextField defaultValue={group?.name ?? ''} placeholder="Checkout beta testers" />
      </FieldShell>
      <FieldShell label="Description">
        <TextAreaField defaultValue={group?.description ?? ''} placeholder="Who this group is used to test" rows={3} />
      </FieldShell>
      <FieldShell label="User coverage">
        <SelectField value={userMode} onChange={(event) => setUserMode(event.target.value as FeatureAudienceGroup['userMode'])}>
          <option value="all">All eligible users</option>
          <option value="selected">Selected users</option>
        </SelectField>
      </FieldShell>
      <CheckboxGrid title="Selected users">
        {selectableUsers.map((user) => (
          <CheckboxRow key={user.id} label={`${user.name ?? user.email} - ${user.email}`} defaultChecked={userMode === 'all' || selectedUserIds.has(user.id)} disabled={userMode === 'all'} />
        ))}
      </CheckboxGrid>
      <FieldShell label="Platform coverage">
        <SelectField value={platformMode} onChange={(event) => setPlatformMode(event.target.value as FeatureAudienceGroup['platformMode'])}>
          <option value="all">All platforms</option>
          <option value="selected">Selected platforms</option>
        </SelectField>
      </FieldShell>
      <CheckboxGrid title="Platforms">
        {app.platforms.map((platform) => (
          <CheckboxRow key={platform.id} label={platform.name} defaultChecked={platformMode === 'all' || selectedPlatformIds.has(platform.id)} disabled={platformMode === 'all'} />
        ))}
      </CheckboxGrid>
      <CheckboxGrid title="Feature flags">
        {app.flagDefinitions.map((flag) => (
          <CheckboxRow key={flag.id} label={flag.key} defaultChecked={selectedFlagIds.has(flag.id)} />
        ))}
      </CheckboxGrid>
      <CheckboxGrid title="Kill switches">
        {app.killSwitches.map((killSwitch) => (
          <CheckboxRow key={killSwitch.id} label={killSwitch.name} defaultChecked={selectedKillSwitchIds.has(killSwitch.id)} />
        ))}
      </CheckboxGrid>
    </div>
  );
}

function CheckboxGrid({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-gray-700">{title}</p>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function CheckboxRow({ defaultChecked, disabled = false, label }: { defaultChecked: boolean; disabled?: boolean; label: string }) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700">
      <input className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50" type="checkbox" defaultChecked={defaultChecked} disabled={disabled} />
      <span>{label}</span>
    </label>
  );
}
