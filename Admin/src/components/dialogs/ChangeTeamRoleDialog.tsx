import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { OrganisationMember, Team } from '../../features/admin/types';
import { ReadOnlyUser } from './ReadOnlyUser';

export function ChangeTeamRoleDialog({
  member,
  onClose,
  open,
  team,
}: {
  member: OrganisationMember | null;
  onClose: () => void;
  open: boolean;
  team: Team | null;
}) {
  return (
    <Modal
      isOpen={open && Boolean(member) && Boolean(team)}
      onClose={onClose}
      title="Change Team Role"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>Save changes</Button>
        </>
      }
    >
      {member && team ? (
        <div className="space-y-4">
          <ReadOnlyUser name={member.name ?? member.email} email={member.email} />
          <FieldShell label="Team">
            <TextField disabled value={team.name} />
          </FieldShell>
          <FieldShell label="Team role">
            <SelectField defaultValue={member.teamRoles[team.name] ?? 'member'}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </SelectField>
          </FieldShell>
        </div>
      ) : null}
    </Modal>
  );
}
