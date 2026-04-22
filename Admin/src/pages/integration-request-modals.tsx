import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button';
import { FieldShell, TextAreaField, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import type {
  IntegrationClaimCredentials,
  IntegrationClaimDeliveryMode,
  IntegrationRequestDetail,
} from '../features/admin/types';

type AcceptInput = {
  label?: string;
  clientSecret?: string;
  deliveryMode: IntegrationClaimDeliveryMode;
};

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
  const [deliveryMode, setDeliveryMode] = useState<IntegrationClaimDeliveryMode>('email');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLabel('');
      setClientSecret('');
      setDeliveryMode('email');
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
        deliveryMode,
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
        <DeliveryModeChooser
          contactEmail={detail.contact_email}
          value={deliveryMode}
          onChange={setDeliveryMode}
        />
      </div>
    </Modal>
  );
}

export function DeliveryModeChooser({
  contactEmail,
  value,
  onChange,
}: {
  contactEmail: string;
  value: IntegrationClaimDeliveryMode;
  onChange: (next: IntegrationClaimDeliveryMode) => void;
}) {
  return (
    <FieldShell
      label="Credential delivery"
      hint="Reveal shows the secret once in this admin; email sends a one-time claim link."
    >
      <div className="flex flex-col gap-2 text-sm text-gray-700">
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="delivery-mode"
            checked={value === 'email'}
            onChange={() => onChange('email')}
            className="mt-0.5"
          />
          <span>
            Email claim link to <span className="font-mono text-xs">{contactEmail}</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="delivery-mode"
            checked={value === 'reveal'}
            onChange={() => onChange('reveal')}
            className="mt-0.5"
          />
          <span>Reveal the secret here (do not email)</span>
        </label>
      </div>
    </FieldShell>
  );
}

export function CredentialsRevealModal({
  credentials,
  isOpen,
  onClose,
}: {
  credentials: IntegrationClaimCredentials | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen={isOpen && credentials !== null}
      onClose={onClose}
      title="Client credentials"
      widthClassName="max-w-xl"
      footer={
        <Button variant="primary" onClick={onClose}>
          I have copied these values
        </Button>
      }
    >
      {credentials ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Copy these now. The client secret will not be shown again — if you close this dialog
            without saving it you must rotate the secret.
          </div>
          <CopyRow label="domain" value={credentials.domain} />
          <CopyRow label="hash_prefix" value={credentials.hash_prefix} />
          <CopyRow label="client_hash" value={credentials.client_hash} />
          <CopyRow label="client_secret" value={credentials.client_secret} sensitive />
        </div>
      ) : null}
    </Modal>
  );
}

function CopyRow({ label, value, sensitive }: { label: string; value: string; sensitive?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
        <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <div
        className={
          sensitive
            ? 'break-all font-mono text-sm text-gray-900'
            : 'break-all font-mono text-sm text-gray-700'
        }
      >
        {value}
      </div>
    </div>
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
