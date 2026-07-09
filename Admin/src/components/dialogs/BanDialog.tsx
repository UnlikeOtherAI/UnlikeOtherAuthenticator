import { useEffect, useState } from 'react';

import { Button } from '../ui/Button';
import { FieldShell, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import { useCreateBanMutation } from '../../features/admin/admin-queries';

export type BanKind = 'email' | 'ip' | 'pattern';

const PLACEHOLDER: Record<BanKind, string> = {
  ip: '185.220.101.0/24',
  pattern: '*@tempmail.example',
  email: 'spam@example.com',
};

const VALUE_LABEL: Record<BanKind, string> = {
  ip: 'IP address or CIDR range',
  pattern: 'Email pattern (glob, e.g. *@evil.com)',
  email: 'Email address',
};

export function BanDialog({
  kind,
  onClose,
  open,
}: {
  kind: BanKind;
  onClose: () => void;
  open: boolean;
}) {
  const createBan = useCreateBanMutation();
  const [value, setValue] = useState('');
  const [domain, setDomain] = useState('');
  const [reason, setReason] = useState('');

  // Start each open with a clean form (the dialog instance is reused across kinds).
  useEffect(() => {
    if (open) {
      setValue('');
      setDomain('');
      setReason('');
    }
  }, [open, kind]);

  const canSubmit = value.trim().length > 0 && domain.trim().length > 0 && !createBan.isPending;

  const submit = () => {
    if (!canSubmit) return;
    createBan.mutate(
      { type: kind, value: value.trim(), domain: domain.trim(), reason: reason.trim() || undefined },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Add ${kind} ban`}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled={!canSubmit} onClick={submit}>
            {createBan.isPending ? 'Adding…' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FieldShell label={VALUE_LABEL[kind]}>
          <TextField
            className="font-mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={PLACEHOLDER[kind]}
          />
        </FieldShell>
        <FieldShell label="Domain" hint="Client domain this ban applies to">
          <TextField
            className="font-mono"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="app.example.com"
          />
        </FieldShell>
        <FieldShell
          label="Reason"
          error={createBan.isError ? 'Could not create the ban — check the values and try again.' : undefined}
        >
          <TextField
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Spam, abuse, or source label"
          />
        </FieldShell>
      </div>
    </Modal>
  );
}
