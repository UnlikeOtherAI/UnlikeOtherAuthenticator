import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button';
import { FieldShell, TextAreaField, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import type { IntegrationRequestDetail } from '../features/admin/types';

type AcceptInput = { label?: string; clientSecret?: string };

export function AcceptIntegrationModal({
  detail,
  isOpen,
  onClose,
  onSubmit,
}: {
  detail: IntegrationRequestDetail;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: AcceptInput) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLabel('');
      setClientSecret('');
      setError(null);
    }
  }, [isOpen]);

  async function submit() {
    if (clientSecret && clientSecret.trim().length < 32) {
      setError('Client secret must be at least 32 characters.');
      return;
    }
    try {
      await onSubmit({
        label: label.trim() || undefined,
        clientSecret: clientSecret.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Accept Integration"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={submit}>
            Accept
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Verify the fingerprint and domain below match what the partner reported out-of-band.
        </div>
        <FieldShell label="Domain">
          <TextField disabled value={detail.domain} />
        </FieldShell>
        <FieldShell label="JWK fingerprint">
          <TextField disabled className="font-mono" value={detail.jwk_fingerprint} />
        </FieldShell>
        <FieldShell label="Friendly label (optional)" hint="Defaults to the domain if empty.">
          <TextField value={label} onChange={(event) => setLabel(event.target.value)} placeholder={detail.domain} />
        </FieldShell>
        <FieldShell
          label="Custom client secret (optional)"
          hint="Leave empty to auto-generate. Minimum 32 characters."
          error={error ?? undefined}
        >
          <TextField
            className="font-mono"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </FieldShell>
      </div>
    </Modal>
  );
}

export function DeclineIntegrationModal({
  detail,
  isOpen,
  onClose,
  onSubmit,
}: {
  detail: IntegrationRequestDetail;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setError(null);
    }
  }, [isOpen]);

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError('Reason is required.');
      return;
    }
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decline failed');
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Decline Integration"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={submit}>
            Decline
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Declining <span className="font-semibold">{detail.domain}</span> keeps the row but marks it as rejected.
          The partner will not be notified.
        </p>
        <FieldShell label="Reason (internal)" error={error ?? undefined}>
          <TextAreaField rows={4} value={reason} onChange={(event) => setReason(event.target.value)} />
        </FieldShell>
      </div>
    </Modal>
  );
}
