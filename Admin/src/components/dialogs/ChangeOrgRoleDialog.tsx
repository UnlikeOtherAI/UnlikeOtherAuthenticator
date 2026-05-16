import { Button } from '../ui/Button';
import { FieldShell, SelectField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { OrganisationMember } from '../../features/admin/types';
import { ReadOnlyUser } from './ReadOnlyUser';

export function ChangeOrgRoleDialog({ member, onClose, open }: { member: OrganisationMember | null; onClose: () => void; open: boolean }) {
  return (
    <Modal
      isOpen={open && Boolean(member)}
      onClose={onClose}
      title="Change Organisation Role"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled title="Not yet implemented" onClick={onClose}>Save changes</Button>
        </>
      }
    >
      {member ? (
        <div className="space-y-4">
          <ReadOnlyUser name={member.name ?? member.email} email={member.email} />
          <FieldShell label="Organisation role">
            <SelectField defaultValue={member.role}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </SelectField>
          </FieldShell>
          <p className="text-sm text-gray-500">Coming soon — backend wiring pending.</p>
        </div>
      ) : null}
    </Modal>
  );
}
