import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import {
  useCreateKillSwitchMutation,
  useUpdateKillSwitchMutation,
} from '../../features/admin/admin-queries';
import type { AppFlagSummary, KillSwitchEntry } from '../../features/admin/types';
import { KillSwitchFormSchema, type KillSwitchFormValues } from '../../schemas/admin';

export function KillSwitchDialog({
  app,
  killSwitch,
  onClose,
  open,
}: {
  app: AppFlagSummary | null;
  killSwitch: KillSwitchEntry | null;
  onClose: () => void;
  open: boolean;
}) {
  const isEdit = killSwitch !== null;
  const appId = app?.id ?? '';
  const createMutation = useCreateKillSwitchMutation(appId);
  const updateMutation = useUpdateKillSwitchMutation(appId, killSwitch?.id ?? '');
  const mutation = isEdit ? updateMutation : createMutation;
  const form = useForm<KillSwitchFormValues>({
    resolver: zodResolver(KillSwitchFormSchema),
    defaultValues: defaultValues(killSwitch),
  });

  useEffect(() => {
    if (open) {
      form.reset(defaultValues(killSwitch));
    }
  }, [form, killSwitch, open]);

  async function submit(values: KillSwitchFormValues) {
    if (!app) return;
    await mutation.mutateAsync({
      name: values.name,
      platform: values.platform,
      type: values.type,
      versionField: values.versionField,
      operator: values.operator,
      versionValue: values.versionValue,
      versionMax: values.versionMax || null,
      versionScheme: values.versionScheme,
      latestVersion: values.latestVersion || null,
      active: values.active === 'active',
      priority: values.priority,
      cacheTtl: values.cacheTtl,
    });
    onClose();
  }

  return (
    <Modal
      isOpen={open && Boolean(app)}
      onClose={onClose}
      title={isEdit ? 'Edit Kill Switch' : 'Add Kill Switch'}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled={mutation.isPending} onClick={form.handleSubmit(submit)}>
            {mutation.isPending ? 'Saving...' : isEdit ? 'Save changes' : 'Add'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="Rule name" error={form.formState.errors.name?.message}>
          <TextField {...form.register('name')} placeholder="Block legacy iOS builds" />
        </FieldShell>
        <FieldShell label="Platform" error={form.formState.errors.platform?.message}>
          <SelectField {...form.register('platform')}>
            <option value="both">All platforms</option>
            {app?.platforms.map((platform) => (
              <option key={platform.id} value={platform.key}>{platform.name}</option>
            ))}
          </SelectField>
        </FieldShell>
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell label="Type" error={form.formState.errors.type?.message}>
            <SelectField {...form.register('type')}>
              <option value="hard">Hard block</option>
              <option value="soft">Soft warning</option>
              <option value="info">Info</option>
              <option value="maintenance">Maintenance</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Version field" error={form.formState.errors.versionField?.message}>
            <SelectField {...form.register('versionField')}>
              <option value="versionName">versionName</option>
              <option value="versionCode">versionCode</option>
              <option value="buildNumber">buildNumber</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Operator" error={form.formState.errors.operator?.message}>
            <SelectField {...form.register('operator')}>
              <option value="lt">Less than</option>
              <option value="lte">Less than or equal</option>
              <option value="eq">Equals</option>
              <option value="gte">Greater than or equal</option>
              <option value="gt">Greater than</option>
              <option value="range">Range</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Version scheme" error={form.formState.errors.versionScheme?.message}>
            <SelectField {...form.register('versionScheme')}>
              <option value="semver">semver</option>
              <option value="integer">integer</option>
              <option value="date">date</option>
              <option value="custom">custom</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Minimum / value" error={form.formState.errors.versionValue?.message}>
            <TextField {...form.register('versionValue')} placeholder="2.1.0" />
          </FieldShell>
          <FieldShell label="Maximum" error={form.formState.errors.versionMax?.message}>
            <TextField {...form.register('versionMax')} placeholder="Only for ranges" />
          </FieldShell>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell label="Latest version" error={form.formState.errors.latestVersion?.message}>
            <TextField {...form.register('latestVersion')} placeholder="2.1.0" />
          </FieldShell>
          <FieldShell label="Status" error={form.formState.errors.active?.message}>
            <SelectField {...form.register('active')}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Priority" error={form.formState.errors.priority?.message}>
            <TextField {...form.register('priority')} type="number" />
          </FieldShell>
          <FieldShell label="Cache TTL" error={form.formState.errors.cacheTtl?.message}>
            <TextField {...form.register('cacheTtl')} type="number" />
          </FieldShell>
        </div>
        {mutation.isError ? <p className="text-sm text-red-600">Could not save the kill switch.</p> : null}
      </form>
    </Modal>
  );
}

function defaultValues(killSwitch: KillSwitchEntry | null): KillSwitchFormValues {
  const platform = killSwitch?.platformMode === 'selected' ? killSwitch.platformIds[0] : 'both';

  return {
    name: killSwitch?.name ?? '',
    platform: platform ?? 'both',
    type: killSwitch?.type ?? 'hard',
    versionField: killSwitch?.versionField ?? 'versionName',
    operator: killSwitch?.operator ?? 'lt',
    versionValue: killSwitch?.versionValue ?? '',
    versionMax: killSwitch?.versionMax ?? '',
    versionScheme: killSwitch?.versionScheme ?? 'semver',
    latestVersion: killSwitch?.latestVersion ?? '',
    active: killSwitch?.active === false ? 'paused' : 'active',
    priority: killSwitch?.priority ?? 0,
    cacheTtl: killSwitch?.cacheTtl ?? 3600,
  };
}
