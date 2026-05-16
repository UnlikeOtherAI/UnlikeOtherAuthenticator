import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { Organisation, PreapprovedMember } from '../../features/admin/types';

export function PreapprovalDialog({
  onClose,
  open,
  organisation,
  preapproval,
}: {
  onClose: () => void;
  open: boolean;
  organisation: Organisation | null;
  preapproval: PreapprovedMember | null;
}) {
  const isEdit = preapproval !== null;
  return (
    <Modal
      isOpen={open && Boolean(organisation)}
      onClose={onClose}
      title={isEdit ? 'Edit Pre-Approved User' : 'Add Pre-Approved User'}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>{isEdit ? 'Save changes' : 'Add'}</Button>
        </>
      }
    >
      {organisation ? (
        <div className="space-y-4">
          <FieldShell label="Email address">
            <TextField defaultValue={preapproval?.email ?? ''} placeholder="user@example.com" type="email" />
          </FieldShell>
          <FieldShell label="Org role">
            <SelectField defaultValue={preapproval?.role ?? 'member'}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Target team">
            <SelectField defaultValue={organisation.teams.find((team) => team.name === preapproval?.targetTeam)?.id ?? organisation.teams[0]?.id}>
              {organisation.teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </SelectField>
          </FieldShell>
          <FieldShell label="Verification method">
            <SelectField defaultValue={preapproval?.method ?? 'ANY'}>
              <option value="ANY">Any verified login</option>
              <option value="EMAIL">Email</option>
              <option value="GOOGLE">Google</option>
              <option value="GITHUB">GitHub</option>
              <option value="MICROSOFT">Microsoft</option>
              <option value="APPLE">Apple</option>
            </SelectField>
          </FieldShell>
        </div>
      ) : null}
    </Modal>
  );
}
