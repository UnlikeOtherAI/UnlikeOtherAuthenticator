import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { Organisation, Team } from '../../features/admin/types';

export function AddMemberDialog({
  onClose,
  open,
  organisation,
  team,
}: {
  onClose: () => void;
  open: boolean;
  organisation: Organisation | null;
  team?: Team;
}) {
  return (
    <Modal
      isOpen={open && Boolean(organisation)}
      onClose={onClose}
      title="Add Member"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled title="Not yet implemented" onClick={onClose}>Add</Button>
        </>
      }
    >
      {organisation ? (
        <div className="space-y-4">
          <FieldShell label="User email or ID" hint="The production endpoint should add by user ID to avoid enumeration.">
            <TextField placeholder="user@example.com" />
          </FieldShell>
          <FieldShell label="Org role">
            <SelectField defaultValue="member">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Team">
            <SelectField defaultValue={team?.id ?? organisation.teams.find((entry) => entry.isDefault)?.id}>
              {organisation.teams.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </SelectField>
          </FieldShell>
          <FieldShell label="Team role">
            <SelectField defaultValue="member">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </SelectField>
          </FieldShell>
          <p className="text-sm text-gray-500">Coming soon — backend wiring pending.</p>
        </div>
      ) : null}
    </Modal>
  );
}
