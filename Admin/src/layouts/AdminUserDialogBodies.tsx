import { useState } from 'react';

import { FieldShell, SelectField, TextField } from '../components/ui/FormFields';
import type { Organisation, UserSummary } from '../features/admin/types';

export function EditUserDialogBody({ user }: { user: UserSummary }) {
  return (
    <div className="space-y-4">
      <FieldShell label="Display name">
        <TextField defaultValue={user.name ?? ''} placeholder="User name" />
      </FieldShell>
      <FieldShell label="Email address">
        <TextField defaultValue={user.email} type="email" />
      </FieldShell>
      <FieldShell label="Status">
        <SelectField defaultValue={user.status}>
          <option value="active">Active</option>
          <option value="banned">Banned</option>
          <option value="disabled">Disabled</option>
        </SelectField>
      </FieldShell>
    </div>
  );
}

export function AddUserToTeamDialogBody({ organisations, user }: { organisations: Organisation[]; user: UserSummary }) {
  const defaultOrg = organisations[0];
  const [selectedOrgId, setSelectedOrgId] = useState(defaultOrg?.id ?? '');
  const selectedOrg = organisations.find((organisation) => organisation.id === selectedOrgId) ?? defaultOrg;
  const defaultTeamId = selectedOrg?.teams.find((team) => team.isDefault)?.id ?? selectedOrg?.teams[0]?.id;

  return (
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
    </div>
  );
}

export function ReadOnlyUser({ email, name }: { email: string; name: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2">
      <p className="text-sm font-medium text-gray-900">{name}</p>
      <p className="text-xs text-gray-500">{email}</p>
    </div>
  );
}
