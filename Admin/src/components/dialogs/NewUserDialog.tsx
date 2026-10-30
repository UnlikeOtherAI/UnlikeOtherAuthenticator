import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { useCreateUserMutation } from '../../features/admin/admin-queries';
import { NewUserFormSchema, type NewUserFormValues } from '../../schemas/admin';
import { Button } from '../ui/Button';
import { FieldShell, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';

type Props = { open: boolean; onClose: () => void; onCreated: (id: string) => void };

export function NewUserDialog(props: Props) {
  return props.open ? <NewUserForm {...props} /> : null;
}

function NewUserForm({ onClose, onCreated }: Props) {
  const mutation = useCreateUserMutation();
  const form = useForm<NewUserFormValues>({
    resolver: zodResolver(NewUserFormSchema),
    defaultValues: { email: '', password: '', name: '', accountExpiresAt: '' },
  });

  async function submit(values: NewUserFormValues) {
    try {
      const user = await mutation.mutateAsync({
        email: values.email.trim(),
        password: values.password,
        ...(values.name ? { name: values.name } : {}),
        ...(values.accountExpiresAt ? { accountExpiresAt: new Date(values.accountExpiresAt).toISOString() } : {}),
      });
      form.reset();
      onClose();
      onCreated(user.id);
    } catch {
      // Keep the form available so the operator can correct or retry it.
    }
  }

  return (
    <Modal isOpen isPending={mutation.isPending} isDirty={form.formState.isDirty} onClose={onClose}
      title="Create user" footer={<Button variant="primary" icon="check" type="submit" form="create-user-form" disabled={mutation.isPending}>
        {mutation.isPending ? 'Creating…' : 'Create user'}
      </Button>}>
      <form id="create-user-form" className="space-y-4" onSubmit={(event) => { void form.handleSubmit(submit)(event); }}>
        <p className="text-sm text-gray-500">Create a UOA account for sign-in across products. Add team access from the user page afterward.</p>
        <FieldShell label="Email" error={form.formState.errors.email?.message}>
          <TextField {...form.register('email')} type="email" autoComplete="off" placeholder="reviewer@example.com" />
        </FieldShell>
        <FieldShell label="Name (optional)" error={form.formState.errors.name?.message}>
          <TextField {...form.register('name')} autoComplete="off" />
        </FieldShell>
        <FieldShell label="Password" hint="At least 8 characters. Share it through a secure channel." error={form.formState.errors.password?.message}>
          <TextField {...form.register('password')} type="password" autoComplete="new-password" />
        </FieldShell>
        <FieldShell label="Expires at (optional)" hint="Uses your local time. Access ends at this time on every UOA sign-in and token check." error={form.formState.errors.accountExpiresAt?.message}>
          <TextField {...form.register('accountExpiresAt')} type="datetime-local" />
        </FieldShell>
        {mutation.isError ? <p role="alert" className="text-sm text-red-600">
          {mutation.error instanceof Error && 'status' in mutation.error && mutation.error.status === 409
            ? 'A global account with this email already exists.'
            : 'Could not create the user. Check the details and try again.'}
        </p> : null}
      </form>
    </Modal>
  );
}
