import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../ui/Button';
import { FieldShell, TextAreaField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { Team } from '../../features/admin/types';
import { TeamFormSchema, type TeamFormValues } from '../../schemas/admin';

export function TeamDialog({
  onClose,
  onSave,
  open,
  team,
}: {
  onClose: () => void;
  onSave?: (values: TeamFormValues) => Promise<unknown>;
  open: boolean;
  team: Team | null;
}) {
  const isEdit = team !== null;
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const form = useForm<TeamFormValues>({
    resolver: zodResolver(TeamFormSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: team?.name ?? '',
        description: team?.description ?? '',
      });
      setSaveError(false);
    }
  }, [form, open, team]);

  async function submit(values: TeamFormValues) {
    if (!onSave) {
      onClose();
      return;
    }

    setSaving(true);
    setSaveError(false);
    try {
      await onSave(values);
      onClose();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={isEdit ? 'Edit Team' : 'Add Team'}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            icon="check"
            variant="primary"
            disabled={saving || !onSave}
            title={!onSave ? 'Not yet implemented' : undefined}
            onClick={form.handleSubmit(submit)}
          >
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Add'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="Team name" error={form.formState.errors.name?.message}>
          <TextField {...form.register('name')} placeholder="Engineering" />
        </FieldShell>
        <FieldShell label="Description" error={form.formState.errors.description?.message}>
          <TextAreaField {...form.register('description')} placeholder="Team purpose" rows={3} />
        </FieldShell>
        {team?.isDefault ? (
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            Default teams can be renamed, but cannot be deleted or have their default status changed.
          </p>
        ) : null}
        {saveError ? (
          <p className="text-sm text-red-600">
            Could not save the team. Check the name and try again.
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
