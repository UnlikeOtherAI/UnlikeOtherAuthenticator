import type { ReactNode } from 'react';

import { FieldShell, SelectField, TextField } from '../components/ui/FormFields';
import type { AppFlagSummary, FeatureFlagDefinition, KillSwitchEntry } from '../features/admin/types';

type FeatureFlagDialogBodyProps = {
  app: AppFlagSummary;
  flag: FeatureFlagDefinition | null;
};

type KillSwitchDialogBodyProps = {
  app: AppFlagSummary;
  killSwitch: KillSwitchEntry | null;
};

export function FeatureFlagDialogBody({ app, flag }: FeatureFlagDialogBodyProps) {
  const selectedPlatformIds = new Set(flag?.platformIds ?? app.platforms.map((platform) => platform.id));
  const allPlatforms = !flag || flag.platformMode === 'all';
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
          <CheckboxRow key={platform.id} label={platform.name} defaultChecked={allPlatforms || selectedPlatformIds.has(platform.id)} />
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
  const selectedPlatformIds = new Set(killSwitch?.platformIds ?? app.platforms.map((platform) => platform.id));
  const allPlatforms = !killSwitch || killSwitch.platformMode === 'all';
  const selectedGroupIds = new Set(killSwitch ? app.audienceGroups.filter((group) => group.killSwitchIds.includes(killSwitch.id)).map((group) => group.id) : []);

  return (
    <div className="space-y-4">
      <FieldShell label="Rule name">
        <TextField defaultValue={killSwitch?.name ?? ''} placeholder="Block legacy iOS builds" />
      </FieldShell>
      <FieldShell label="Platform coverage">
        <SelectField defaultValue={killSwitch?.platformMode ?? 'all'}>
          <option value="all">All platforms</option>
          <option value="selected">Selected platforms</option>
        </SelectField>
      </FieldShell>
      <CheckboxGrid title="Platforms">
        {app.platforms.map((platform) => (
          <CheckboxRow key={platform.id} label={platform.name} defaultChecked={allPlatforms || selectedPlatformIds.has(platform.id)} />
        ))}
      </CheckboxGrid>
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
