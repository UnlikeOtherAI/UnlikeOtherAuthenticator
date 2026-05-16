import { Button } from '../ui/Button';
import { FieldShell, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import type { BanRecord } from '../../features/admin/types';

export type BanKind = 'email' | 'ip' | 'pattern';

export function BanDialog({
  ban,
  kind,
  onClose,
  open,
}: {
  ban: BanRecord | null;
  kind: BanKind;
  onClose: () => void;
  open: boolean;
}) {
  const isEdit = ban !== null;
  const placeholder = kind === 'ip' ? '185.220.101.0/24' : kind === 'pattern' ? '*@tempmail.example' : 'spam@example.com';
  const label = kind === 'ip' ? 'IP address or CIDR range' : kind === 'pattern' ? 'Email pattern' : 'Email address';

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`${isEdit ? 'Edit' : 'Add'} ${kind} ban`}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={onClose}>{isEdit ? 'Save changes' : 'Add'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <FieldShell label={label}>
          <TextField className="font-mono" defaultValue={ban?.value ?? ''} placeholder={placeholder} />
        </FieldShell>
        <FieldShell label="Label or reason">
          <TextField defaultValue={ban?.label ?? ban?.reason ?? ''} placeholder="Spam, abuse, or source label" />
        </FieldShell>
        {kind === 'ip' ? (
          <FieldShell label="Expiry">
            <TextField defaultValue={ban?.expiry ?? ''} type="date" />
          </FieldShell>
        ) : null}
      </div>
    </Modal>
  );
}
