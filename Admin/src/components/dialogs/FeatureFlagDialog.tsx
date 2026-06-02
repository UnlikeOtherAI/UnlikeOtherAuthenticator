import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import {
  useCreateFeatureFlagMutation,
  useUpdateFeatureFlagMutation,
} from '../../features/admin/admin-queries';
import type { AppFlagSummary, FeatureFlagDefinition } from '../../features/admin/types';
import { FeatureFlagFormSchema, type FeatureFlagFormValues } from '../../schemas/admin';

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
  const appId = app?.id ?? '';
  const createMutation = useCreateFeatureFlagMutation(appId);
  const updateMutation = useUpdateFeatureFlagMutation(appId, flag?.id ?? '');
  const mutation = isEdit ? updateMutation : createMutation;
  const form = useForm<FeatureFlagFormValues>({
    resolver: zodResolver(FeatureFlagFormSchema),
    defaultValues: defaultValues(flag),
  });

  useEffect(() => {
    if (open) {
      form.reset(defaultValues(flag));
    }
  }, [flag, form, open]);

  async function submit(values: FeatureFlagFormValues) {
    if (!app) return;
    await mutation.mutateAsync({
      key: values.key,
      description: values.description,
      defaultState: values.defaultState === 'enabled',
    });
    onClose();
  }

  return (
    <Modal
      isOpen={open && Boolean(app)}
      onClose={onClose}
      title={isEdit ? 'Edit Feature Flag' : 'Add Feature Flag'}
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
        <FieldShell label="Flag key" error={form.formState.errors.key?.message}>
          <TextField {...form.register('key')} className="font-mono" placeholder="new_checkout" />
        </FieldShell>
        <FieldShell label="Description" error={form.formState.errors.description?.message}>
          <TextField {...form.register('description')} placeholder="New checkout flow" />
        </FieldShell>
        <FieldShell label="Default state" error={form.formState.errors.defaultState?.message}>
          <SelectField {...form.register('defaultState')}>
            <option value="disabled">Disabled</option>
            <option value="enabled">Enabled</option>
          </SelectField>
        </FieldShell>
        {mutation.isError ? <p className="text-sm text-red-600">Could not save the feature flag.</p> : null}
      </form>
    </Modal>
  );
}

function defaultValues(flag: FeatureFlagDefinition | null): FeatureFlagFormValues {
  return {
    key: flag?.key ?? '',
    description: flag?.description ?? '',
    defaultState: flag?.defaultState ? 'enabled' : 'disabled',
  };
}
