import { Button } from '../ui/Button';
import { FieldShell, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { Organisation } from '../../features/admin/types';

export function EditOrganisationDialog({ onClose, open, organisation }: { onClose: () => void; open: boolean; organisation: Organisation | null }) {
  return (
    <Modal
      isOpen={open && Boolean(organisation)}
      onClose={onClose}
      title="Edit Organisation"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>Save changes</Button>
        </>
      }
    >
      {organisation ? (
        <div className="space-y-4">
          <FieldShell label="Organisation name">
            <TextField defaultValue={organisation.name} />
          </FieldShell>
          <FieldShell label="Slug">
            <TextField className="font-mono" defaultValue={organisation.slug} />
          </FieldShell>
        </div>
      ) : null}
    </Modal>
  );
}
