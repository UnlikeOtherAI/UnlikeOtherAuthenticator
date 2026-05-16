import { Button } from '../ui/Button';
import { FieldShell, SelectField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { Organisation } from '../../features/admin/types';

export function TransferOwnershipDialog({ onClose, open, organisation }: { onClose: () => void; open: boolean; organisation: Organisation | null }) {
  return (
    <Modal
      isOpen={open && Boolean(organisation)}
      onClose={onClose}
      title="Transfer Ownership"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>Transfer</Button>
        </>
      }
    >
      {organisation ? (
        <div className="space-y-4">
          <FieldShell label="New owner">
            <SelectField defaultValue={organisation.owner.id}>
              {organisation.members.map((member) => (
                <option key={member.id} value={member.id}>{member.name ?? member.email} — {member.email}</option>
              ))}
            </SelectField>
          </FieldShell>
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            A production write endpoint is required before this can transfer stored ownership. The endpoint must enforce owner-only access and prevent removing the final owner.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
