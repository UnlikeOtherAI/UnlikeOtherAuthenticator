import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import { PLATFORM_KIND_OPTIONS } from '../../features/admin/platforms';
import type { AppFlagSummary } from '../../features/admin/types';

export function RegisterPlatformDialog({ app, onClose, open }: { app: AppFlagSummary | null; onClose: () => void; open: boolean }) {
  return (
    <Modal
      isOpen={open && Boolean(app)}
      onClose={onClose}
      title="Add Platform"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled title="Not yet implemented" onClick={onClose}>Add</Button>
        </>
      }
    >
      {app ? (
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
            <TextField className="font-mono" placeholder={app.identifier} />
          </FieldShell>
          <p className="text-sm text-gray-500">Coming soon — backend wiring pending.</p>
        </div>
      ) : null}
    </Modal>
  );
}
