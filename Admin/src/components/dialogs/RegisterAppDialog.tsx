import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import { PLATFORM_KIND_OPTIONS } from '../../features/admin/platforms';

export function RegisterAppDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Register App"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>Add</Button>
        </>
      }
    >
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
      </div>
    </Modal>
  );
}
