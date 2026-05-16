import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { UserSummary } from '../../features/admin/types';

export function EditUserDialog({ onClose, open, user }: { onClose: () => void; open: boolean; user: UserSummary | null }) {
  return (
    <Modal
      isOpen={open && Boolean(user)}
      onClose={onClose}
      title="Edit User"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>Save changes</Button>
        </>
      }
    >
      {user ? (
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
      ) : null}
    </Modal>
  );
}
