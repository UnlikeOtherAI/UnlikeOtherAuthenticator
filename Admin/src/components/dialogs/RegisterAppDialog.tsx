import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import { useCreateAppMutation, useOrganisationsQuery } from '../../features/admin/admin-queries';
import { PLATFORM_KIND_OPTIONS } from '../../features/admin/platforms';
import { RegisterAppFormSchema, type RegisterAppFormValues } from '../../schemas/admin';

export function RegisterAppDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const { data: organisations = [] } = useOrganisationsQuery();
  const mutation = useCreateAppMutation();
  const form = useForm<RegisterAppFormValues>({
    resolver: zodResolver(RegisterAppFormSchema),
    defaultValues: { name: '', identifier: '', platform: 'web', domain: '', orgId: '' },
  });

  async function submit(values: RegisterAppFormValues) {
    await mutation.mutateAsync(values);
    form.reset();
    onClose();
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Register App"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled={mutation.isPending} onClick={form.handleSubmit(submit)}>
            {mutation.isPending ? 'Adding...' : 'Add'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="App name" error={form.formState.errors.name?.message}>
          <TextField {...form.register('name')} placeholder="Customer Portal" />
        </FieldShell>
        <FieldShell label="Identifier" error={form.formState.errors.identifier?.message}>
          <TextField {...form.register('identifier')} className="font-mono" placeholder="com.example.portal" />
        </FieldShell>
        <FieldShell label="Platform" error={form.formState.errors.platform?.message}>
          <SelectField {...form.register('platform')}>
            {PLATFORM_KIND_OPTIONS.map((platform) => (
              <option key={platform.value} value={platform.value}>{platform.label}</option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Domain" error={form.formState.errors.domain?.message}>
          <TextField {...form.register('domain')} className="font-mono" placeholder="app.example.com" />
        </FieldShell>
        <FieldShell label="Organisation" error={form.formState.errors.orgId?.message}>
          <SelectField {...form.register('orgId')} className="w-full">
            <option value="">Select organisation</option>
            {organisations.map((organisation) => (
              <option key={organisation.id} value={organisation.id}>{organisation.name}</option>
            ))}
          </SelectField>
        </FieldShell>
        {mutation.isError ? <p className="text-sm text-red-600">Could not register the app.</p> : null}
      </form>
    </Modal>
  );
}
