import type { ReactNode } from 'react';

import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { AppFlagSummary, FeatureFlagDefinition } from '../../features/admin/types';

export function FeatureFlagDialog({
  app,
  flag,
  onClose,
  open,
}: {
  app: AppFlagSummary | null;
  flag: FeatureFlagDefinition | null;
  onClose: () => void;
  open: boolean;
}) {
  const isEdit = flag !== null;
  return (
    <Modal
      isOpen={open && Boolean(app)}
      onClose={onClose}
      title={isEdit ? 'Edit Feature Flag' : 'Add Feature Flag'}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>{isEdit ? 'Save changes' : 'Add'}</Button>
        </>
      }
    >
      {app ? <FeatureFlagDialogBody app={app} flag={flag} /> : null}
    </Modal>
  );
}

function FeatureFlagDialogBody({ app, flag }: { app: AppFlagSummary; flag: FeatureFlagDefinition | null }) {
  const selectedPlatformIds = new Set(flag?.platformIds ?? app.platforms.map((platform) => platform.id));
  const allPlatforms = !flag || flag.platformMode === 'all';
  const selectedGroupIds = new Set(
    flag ? app.audienceGroups.filter((group) => group.featureFlagIds.includes(flag.id)).map((group) => group.id) : [],
  );

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
