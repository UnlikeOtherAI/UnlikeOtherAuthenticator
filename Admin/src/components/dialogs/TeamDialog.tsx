import { Button } from '../ui/Button';
import { FieldShell, TextAreaField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { Team } from '../../features/admin/types';

export function TeamDialog({ onClose, open, team }: { onClose: () => void; open: boolean; team: Team | null }) {
  const isEdit = team !== null;
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={isEdit ? 'Edit Team' : 'Add Team'}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>{isEdit ? 'Save changes' : 'Add'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <FieldShell label="Team name">
          <TextField defaultValue={team?.name ?? ''} placeholder="Engineering" />
        </FieldShell>
        <FieldShell label="Description">
          <TextAreaField defaultValue={team?.description ?? ''} placeholder="Team purpose" rows={3} />
        </FieldShell>
        {team?.isDefault ? (
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            Default teams can be renamed, but cannot be deleted or have their default status changed.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
