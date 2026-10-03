import { useForm } from 'react-hook-form';

import { useAddUserToTeamMutation } from '../../features/admin/team-membership-queries';
import type { Organisation, UserSummary, TeamRole } from '../../features/admin/types';
import { Button } from '../ui/Button';
import { FieldShell, SelectField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import { ReadOnlyUser } from './ReadOnlyUser';

type Props = {
  onClose: () => void;
  open: boolean;
  organisations: Organisation[];
  user: UserSummary | null;
};

export function AddUserToTeamDialog({ open, user, ...props }: Props) {
  // Closing or changing users starts a fresh form, including its mutation/error state.
  return open && user ? <AddUserToTeamForm key={user.id} {...props} user={user} /> : null;
}

function AddUserToTeamForm({
  onClose,
  organisations,
  user,
}: Omit<Props, 'open' | 'user'> & { user: UserSummary }) {
  const mutation = useAddUserToTeamMutation();
  const { register, watch, setValue, handleSubmit, formState } = useForm({
    defaultValues: { orgId: '', teamId: '', teamRole: 'member' as TeamRole },
  });
  const selectedOrg = organisations.find((org) => org.id === watch('orgId')) ?? organisations[0];
  const selectedTeam =
    selectedOrg?.teams.find((team) => team.id === watch('teamId')) ??
    selectedOrg?.teams.find((team) => team.isDefault) ??
    selectedOrg?.teams[0];
  const close = () => {
    if (!mutation.isPending) onClose();
  };
  const submit = handleSubmit(async ({ teamRole }) => {
    if (!selectedOrg || !selectedTeam || mutation.isPending) return;
    try {
      await mutation.mutateAsync({
        userId: user.id,
        orgId: selectedOrg.id,
        teamId: selectedTeam.id,
        teamRole,
      });
      onClose();
    } catch {
      // Keep the form and selected values open for retry; the mutation owns the error.
    }
  });

  return (
    <Modal
      isOpen
      isPending={mutation.isPending}
      isDirty={formState.isDirty}
      onClose={close}
      title="Add User to Team"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button
            icon="check"
            variant="primary"
            type="submit"
            form="add-user-to-team"
            disabled={!selectedTeam || mutation.isPending}
          >
            {mutation.isPending ? 'Adding…' : 'Add'}
          </Button>
        </>
      }
    >
      <form
        id="add-user-to-team"
        className="space-y-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <ReadOnlyUser name={user.name ?? user.email} email={user.email} />
        <FieldShell label="Organisation">
          <SelectField
            {...register('orgId')}
            value={selectedOrg?.id ?? ''}
            disabled={mutation.isPending || !organisations.length}
            onChange={(event) => {
              setValue('orgId', event.target.value, { shouldDirty: true });
              setValue('teamId', '', { shouldDirty: true });
            }}
          >
            {organisations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Target team">
          <SelectField
            {...register('teamId')}
            value={selectedTeam?.id ?? ''}
            disabled={mutation.isPending || !selectedTeam}
          >
            {selectedOrg?.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Team role">
          <SelectField {...register('teamRole')} disabled={mutation.isPending}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </SelectField>
        </FieldShell>
        {!selectedTeam ? (
          <p className="text-sm text-gray-500">No teams are available in this organisation.</p>
        ) : null}
        {selectedOrg && !selectedOrg.members.some((member) => member.id === user.id) ? (
          <p className="text-sm text-gray-500">
            This also adds the user to the organisation. New organisation members join its default
            team.
          </p>
        ) : null}
        {mutation.isError ? (
          <p role="alert" className="text-sm text-red-600">
            Could not add the user. Check their current membership and try again.
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
