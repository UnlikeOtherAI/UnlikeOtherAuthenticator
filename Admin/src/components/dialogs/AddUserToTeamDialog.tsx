import { useState } from 'react';

import { Button } from '../ui/Button';
import { FieldShell, SelectField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { Organisation, UserSummary } from '../../features/admin/types';
import { ReadOnlyUser } from './ReadOnlyUser';

export function AddUserToTeamDialog({
  onClose,
  open,
  organisations,
  user,
}: {
  onClose: () => void;
  open: boolean;
  organisations: Organisation[];
  user: UserSummary | null;
}) {
  const defaultOrg = organisations[0];
  const [selectedOrgId, setSelectedOrgId] = useState(defaultOrg?.id ?? '');
  const selectedOrg = organisations.find((organisation) => organisation.id === selectedOrgId) ?? defaultOrg;
  const defaultTeamId = selectedOrg?.teams.find((team) => team.isDefault)?.id ?? selectedOrg?.teams[0]?.id;

  return (
    <Modal
      isOpen={open && Boolean(user)}
      onClose={onClose}
      title="Add User to Team"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled title="Not yet implemented" onClick={onClose}>Add</Button>
        </>
      }
    >
      {user ? (
        <div className="space-y-4">
          <ReadOnlyUser name={user.name ?? user.email} email={user.email} />
          <FieldShell label="Organisation">
            <SelectField value={selectedOrgId} onChange={(event) => setSelectedOrgId(event.target.value)}>
              {organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>{organisation.name}</option>
              ))}
            </SelectField>
          </FieldShell>
          <FieldShell label="Target team">
            <SelectField key={selectedOrg?.id} defaultValue={defaultTeamId} disabled={!selectedOrg}>
              {selectedOrg?.teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
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
