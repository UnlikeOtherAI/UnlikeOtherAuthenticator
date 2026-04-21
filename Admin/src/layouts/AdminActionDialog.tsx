import { Button } from '../components/ui/Button';
import { FieldShell, SelectField, TextAreaField, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PLATFORM_KIND_OPTIONS } from '../features/admin/platforms';
import { useAdminUi, type AdminDialog } from '../features/shell/admin-ui';
import { FeatureFlagDialogBody, KillSwitchDialogBody } from './AdminFeatureDialogBodies';
import { AddUserToTeamDialogBody, EditUserDialogBody, ReadOnlyUser } from './AdminUserDialogBodies';

export function AdminActionDialog() {
  const { activeDialog, closeDialog } = useAdminUi();

  return (
    <Modal
      isOpen={Boolean(activeDialog)}
      onClose={closeDialog}
      title={activeDialog ? dialogTitle(activeDialog) : 'Edit'}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={closeDialog}>{activeDialog ? submitLabel(activeDialog) : 'Save'}</Button>
        </>
      }
    >
      {activeDialog ? <DialogBody dialog={activeDialog} /> : null}
    </Modal>
  );
}

function DialogBody({ dialog }: { dialog: AdminDialog }) {
  if (dialog.type === 'edit-domain') {
    return (
      <div className="space-y-4">
        <FieldShell label="Domain name" hint="Must match the domain claim in config JWTs.">
          <TextField defaultValue={dialog.domain.name} />
        </FieldShell>
        <FieldShell label="Friendly name">
          <TextField defaultValue={dialog.domain.label} />
        </FieldShell>
        <FieldShell label="Status">
          <SelectField defaultValue={dialog.domain.status}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </SelectField>
        </FieldShell>
      </div>
    );
  }

  if (dialog.type === 'edit-org') {
    return (
      <div className="space-y-4">
        <FieldShell label="Organisation name">
          <TextField defaultValue={dialog.organisation.name} />
        </FieldShell>
        <FieldShell label="Slug">
          <TextField className="font-mono" defaultValue={dialog.organisation.slug} />
        </FieldShell>
      </div>
    );
  }

  if (dialog.type === 'transfer-ownership') {
    return (
      <div className="space-y-4">
        <FieldShell label="New owner">
          <SelectField defaultValue={dialog.organisation.owner.id}>
            {dialog.organisation.members.map((member) => (
              <option key={member.id} value={member.id}>{member.name ?? member.email} — {member.email}</option>
            ))}
          </SelectField>
        </FieldShell>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Ownership transfer is mocked here. The API implementation should enforce owner-only access and prevent removing the final owner.</p>
      </div>
    );
  }

  if (dialog.type === 'add-team' || dialog.type === 'edit-team') {
    const team = dialog.type === 'edit-team' ? dialog.team : null;
    return (
      <div className="space-y-4">
        <FieldShell label="Team name">
          <TextField defaultValue={team?.name ?? ''} placeholder="Engineering" />
        </FieldShell>
        <FieldShell label="Description">
          <TextAreaField defaultValue={team?.description ?? ''} placeholder="Team purpose" rows={3} />
        </FieldShell>
        {team?.isDefault ? <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">Default teams can be renamed, but cannot be deleted or have their default status changed.</p> : null}
      </div>
    );
  }

  if (dialog.type === 'edit-user') {
    return <EditUserDialogBody user={dialog.user} />;
  }

  if (dialog.type === 'add-user-to-team') {
    return <AddUserToTeamDialogBody organisations={dialog.organisations} user={dialog.user} />;
  }

  if (dialog.type === 'add-member') {
    return (
      <div className="space-y-4">
        <FieldShell label="User email or ID" hint="The final API should add by user ID to avoid enumeration. This mock accepts either for layout only.">
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
          <SelectField defaultValue={dialog.team?.id ?? dialog.organisation.teams.find((team) => team.isDefault)?.id}>
            {dialog.organisation.teams.map((team) => (
              <option key={team.id} value={team.id}>{team.name}</option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Team role">
          <SelectField defaultValue={dialog.team ? 'member' : 'member'}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </SelectField>
        </FieldShell>
      </div>
    );
  }

  if (dialog.type === 'change-org-role') {
    return (
      <div className="space-y-4">
        <ReadOnlyUser name={dialog.member.name ?? dialog.member.email} email={dialog.member.email} />
        <FieldShell label="Organisation role">
          <SelectField defaultValue={dialog.member.role}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </SelectField>
        </FieldShell>
      </div>
    );
  }

  if (dialog.type === 'change-team-role') {
    return (
      <div className="space-y-4">
        <ReadOnlyUser name={dialog.member.name ?? dialog.member.email} email={dialog.member.email} />
        <FieldShell label="Team">
          <TextField disabled value={dialog.team.name} />
        </FieldShell>
        <FieldShell label="Team role">
          <SelectField defaultValue={dialog.member.teamRoles[dialog.team.name] ?? 'member'}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </SelectField>
        </FieldShell>
      </div>
    );
  }

  if (dialog.type === 'add-ban' || dialog.type === 'edit-ban') {
    const ban = dialog.type === 'edit-ban' ? dialog.ban : null;
    return (
      <div className="space-y-4">
        <FieldShell label={dialog.kind === 'ip' ? 'IP address or CIDR range' : dialog.kind === 'pattern' ? 'Email pattern' : 'Email address'}>
          <TextField className="font-mono" defaultValue={ban?.value ?? ''} placeholder={dialog.kind === 'ip' ? '185.220.101.0/24' : dialog.kind === 'pattern' ? '*@tempmail.example' : 'spam@example.com'} />
        </FieldShell>
        <FieldShell label="Label or reason">
          <TextField defaultValue={ban?.label ?? ban?.reason ?? ''} placeholder="Spam, abuse, or source label" />
        </FieldShell>
        {dialog.kind === 'ip' ? (
          <FieldShell label="Expiry">
            <TextField defaultValue={ban?.expiry ?? ''} type="date" />
          </FieldShell>
        ) : null}
      </div>
    );
  }

  if (dialog.type === 'add-preapproval' || dialog.type === 'edit-preapproval') {
    const preapproval = dialog.type === 'edit-preapproval' ? dialog.preapproval : null;
    return (
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
          <SelectField defaultValue={dialog.organisation.teams.find((team) => team.name === preapproval?.targetTeam)?.id ?? dialog.organisation.teams[0]?.id}>
            {dialog.organisation.teams.map((team) => (
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
    );
  }

  if (dialog.type === 'register-app') {
    return (
      <div className="space-y-4">
        <FieldShell label="App name">
          <TextField placeholder="Customer Portal" />
        </FieldShell>
        <FieldShell label="Identifier">
          <TextField className="font-mono" placeholder="com.example.portal" />
        </FieldShell>
        <FieldShell label="Platform">
          <SelectField defaultValue="web">
            {PLATFORM_KIND_OPTIONS.map((platform) => (
              <option key={platform.value} value={platform.value}>{platform.label}</option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Domain">
          <TextField className="font-mono" placeholder="app.example.com" />
        </FieldShell>
        <FieldShell label="Organisation">
          <TextField placeholder="Acme Engineering" />
        </FieldShell>
        <FieldShell label="Feature flags">
          <SelectField defaultValue="enabled">
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </SelectField>
        </FieldShell>
      </div>
    );
  }

  if (dialog.type === 'app-settings') {
    return (
      <div className="space-y-4">
        <FieldShell label="App name">
          <TextField defaultValue={dialog.app.name} />
        </FieldShell>
        <FieldShell label="Identifier">
          <TextField className="font-mono" defaultValue={dialog.app.identifier} />
        </FieldShell>
        <FieldShell label="Feature flags">
          <SelectField defaultValue={dialog.app.flagsEnabled ? 'enabled' : 'disabled'}>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </SelectField>
        </FieldShell>
        <FieldShell label="Role matrix">
          <SelectField defaultValue={dialog.app.matrixEnabled ? 'enabled' : 'disabled'}>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </SelectField>
        </FieldShell>
      </div>
    );
  }

  if (dialog.type === 'register-platform') {
    return (
      <div className="space-y-4">
        <FieldShell label="Platform name">
          <TextField placeholder="iPad" />
        </FieldShell>
        <FieldShell label="Platform key">
          <TextField className="font-mono" placeholder="ipad" />
        </FieldShell>
        <FieldShell label="Platform kind">
          <SelectField defaultValue="ios">
            {PLATFORM_KIND_OPTIONS.map((platform) => (
              <option key={platform.value} value={platform.value}>{platform.label}</option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Identifier">
          <TextField className="font-mono" placeholder={dialog.app.identifier} />
        </FieldShell>
      </div>
    );
  }

  if (dialog.type === 'add-feature-flag' || dialog.type === 'edit-feature-flag' || dialog.type === 'app-flags') {
    return <FeatureFlagDialogBody app={dialog.app} flag={dialog.type === 'edit-feature-flag' ? dialog.flag : null} />;
  }

  if (dialog.type === 'add-kill-switch' || dialog.type === 'edit-kill-switch') {
    return <KillSwitchDialogBody app={dialog.app} killSwitch={dialog.type === 'edit-kill-switch' ? dialog.killSwitch : null} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">No editor is available for this action yet.</p>
    </div>
  );
}

function dialogTitle(dialog: AdminDialog) {
  const titles: Record<AdminDialog['type'], string> = {
    'add-ban': `Add ${dialog.type === 'add-ban' ? dialog.kind : ''} ban`,
    'add-feature-flag': 'Add Feature Flag',
    'add-kill-switch': 'Add Kill Switch',
    'add-member': 'Add Member',
    'add-preapproval': 'Add Pre-Approved User',
    'add-team': 'Add Team',
    'add-user-to-team': 'Add User to Team',
    'app-flags': 'Manage Flags',
    'app-settings': 'App Settings',
    'change-org-role': 'Change Organisation Role',
    'change-team-role': 'Change Team Role',
    'edit-ban': `Edit ${dialog.type === 'edit-ban' ? dialog.kind : ''} ban`,
    'edit-domain': 'Edit Domain',
    'edit-feature-flag': 'Edit Feature Flag',
    'edit-org': 'Edit Organisation',
    'edit-kill-switch': 'Edit Kill Switch',
    'edit-preapproval': 'Edit Pre-Approved User',
    'edit-team': 'Edit Team',
    'edit-user': 'Edit User',
    'register-app': 'Register App',
    'register-platform': 'Add Platform',
    'transfer-ownership': 'Transfer Ownership',
  };

  return titles[dialog.type];
}

function submitLabel(dialog: AdminDialog) {
  if (dialog.type === 'add-ban' || dialog.type === 'add-feature-flag' || dialog.type === 'add-kill-switch' || dialog.type === 'add-member' || dialog.type === 'add-team' || dialog.type === 'add-preapproval' || dialog.type === 'add-user-to-team' || dialog.type === 'register-app' || dialog.type === 'register-platform') {
    return 'Add';
  }

  if (dialog.type === 'transfer-ownership') {
    return 'Transfer';
  }

  return 'Save changes';
}
