import { Button } from '../ui/Button';
import { FieldShell, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { AppFlagSummary } from '../../features/admin/types';

export function AppSettingsDialog({ app, onClose, open }: { app: AppFlagSummary | null; onClose: () => void; open: boolean }) {
  return (
    <Modal
      isOpen={open && Boolean(app)}
      onClose={onClose}
      title="App Settings"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled title="Not yet implemented" onClick={onClose}>Save changes</Button>
        </>
      }
    >
      {app ? (
        <div className="space-y-4">
          <FieldShell label="App name">
            <TextField defaultValue={app.name} />
          </FieldShell>
          <FieldShell label="Identifier">
            <TextField className="font-mono" defaultValue={app.identifier} />
          </FieldShell>
          <p className="text-sm text-gray-500">Coming soon — backend wiring pending.</p>
        </div>
      ) : null}
    </Modal>
  );
}
