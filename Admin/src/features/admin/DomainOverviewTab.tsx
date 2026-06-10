import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import { StatusBadge } from '../../components/ui/Status';
import { adminService, type DomainRotateResponse } from '../../services/admin-service';
import { useAdminUi } from '../shell/admin-ui';
import type { Domain } from './types';

type DomainOverviewTabProps = {
  domain: Domain;
  counts: { organisations: number; teams: number; users: number };
};

export function DomainOverviewTab({ counts, domain }: DomainOverviewTabProps) {
  const queryClient = useQueryClient();
  const { confirm } = useAdminUi();
  const [label, setLabel] = useState(domain.label);
  const [rotateResult, setRotateResult] = useState<DomainRotateResponse | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  useEffect(() => {
    setLabel(domain.label);
  }, [domain.label]);

  const updateDomain = useMutation({
    mutationFn: (input: { label?: string; status?: 'active' | 'disabled' }) =>
      adminService.updateDomain(domain.name, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const rotateSecret = useMutation({
    mutationFn: (deliveryMode: 'email' | 'reveal') => adminService.rotateDomainSecret(domain.name, deliveryMode),
    onSuccess: (result) => {
      setRotateResult(result);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (err) => setRotateError(err instanceof Error ? err.message : 'Rotation failed. Please try again.'),
  });

  const labelDirty = label.trim() !== domain.label;
  const isActive = domain.status === 'active';

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard label="Organisations" value={counts.organisations} />
        <MetricCard label="Teams" value={counts.teams} />
        <MetricCard label="Users" value={counts.users} />
      </div>

      <Card className="p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Identity</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              The domain name is immutable — it must match the domain claim in config JWTs. Only the friendly name is editable.
            </p>
          </div>
          <Button
            icon="check"
            variant="primary"
            size="sm"
            disabled={!labelDirty || updateDomain.isPending}
            onClick={() => updateDomain.mutate({ label: label.trim() })}
          >
            {updateDomain.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FieldShell label="Domain name">
            <TextField disabled value={domain.name} />
          </FieldShell>
          <FieldShell label="Friendly name">
            <TextField value={label} placeholder="Acme Inc." onChange={(event) => setLabel(event.target.value)} />
          </FieldShell>
        </div>
        <p className="mt-3 text-xs text-gray-400">Added {domain.created}</p>
      </Card>

      <Card className="p-5">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900">Secret &amp; status</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Domain bearer auth uses hash(domain + shared secret). Rotation issues a fresh secret; the current one keeps
            working until the partner switches over.
          </p>
        </div>
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Client hash</dt>
            <dd className="mt-1">
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{domain.hash}</code>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Secret age</dt>
            <dd className="mt-1">
              {domain.secretAge ? (
                <Badge variant={domain.secretOld ? 'amber' : 'green'}>{domain.secretAge}</Badge>
              ) : (
                <Badge>—</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Status</dt>
            <dd className="mt-1">
              <StatusBadge status={domain.status} />
            </dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={() =>
              confirm(
                `Email claim link for ${domain.name}?`,
                'A one-time claim link will be emailed to the partner contact. The current secret keeps working until the partner claims the new one.',
                async () => {
                  await rotateSecret.mutateAsync('email');
                },
              )
            }
          >
            Rotate
          </Button>
          <Button
            onClick={() =>
              confirm(
                `Rotate ${domain.name} and reveal the new secret?`,
                'A fresh secret will be generated and shown in the admin UI once. No email is sent — deliver the credentials to the partner through your own secure channel. The current secret keeps working until the partner switches to the new one.',
                async () => {
                  await rotateSecret.mutateAsync('reveal');
                },
              )
            }
          >
            Rotate &amp; reveal
          </Button>
          <Button
            variant={isActive ? 'danger' : 'secondary'}
            onClick={() =>
              confirm(
                `${isActive ? 'Disable' : 'Enable'} ${domain.name}?`,
                isActive
                  ? 'Domain bearer auth will be rejected for this domain.'
                  : 'Domain bearer auth will be accepted again for active secrets.',
                async () => {
                  await updateDomain.mutateAsync({ status: isActive ? 'disabled' : 'active' });
                },
              )
            }
          >
            {isActive ? 'Disable domain' : 'Enable domain'}
          </Button>
        </div>
      </Card>

      <RotateNoticeModal result={rotateResult} onClose={() => setRotateResult(null)} />
      <Modal
        isOpen={Boolean(rotateError)}
        onClose={() => setRotateError(null)}
        title="Rotation failed"
        footer={
          <Button variant="primary" onClick={() => setRotateError(null)}>
            Close
          </Button>
        }
      >
        <p className="text-sm text-gray-600">{rotateError}</p>
      </Modal>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-gray-900">{value}</p>
    </Card>
  );
}

function RotateNoticeModal({ onClose, result }: { onClose: () => void; result: DomainRotateResponse | null }) {
  const reveal = result?.delivery_mode === 'reveal' && result.credentials;
  const dispatched = result?.email_dispatched ?? false;
  const title = reveal
    ? 'New credentials (shown once)'
    : dispatched
    ? 'Rotation claim sent'
    : 'Rotation claim not delivered';
  const description = reveal
    ? 'Copy the secret below now — it will not be displayed again. The previous secret keeps working until the partner switches to the new one. Deliver these through your own secure channel.'
    : dispatched
    ? `A one-time claim link has been emailed to ${result?.contact_email ?? 'the partner contact'}. The previous secret stays active until they open the link and confirm.`
    : `A claim token was created but the email to ${result?.contact_email ?? 'the partner contact'} could not be dispatched. Retry the rotation or deliver the link out-of-band.`;

  return (
    <Modal
      isOpen={Boolean(result)}
      onClose={onClose}
      title={title}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3 text-sm text-gray-600">
        <p>{description}</p>
        {result?.credentials ? (
          <dl className="grid grid-cols-1 gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs">
            {(
              [
                ['domain', result.credentials.domain],
                ['client_secret', result.credentials.client_secret],
                ['client_hash', result.credentials.client_hash],
                ['hash_prefix', result.credentials.hash_prefix],
              ] as const
            ).map(([key, value]) => (
              <div key={key}>
                <dt className="font-semibold text-amber-900">{key}</dt>
                <dd className="break-all font-mono text-gray-800">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {result ? (
          <p className="text-xs text-gray-400">
            Domain: <span className="font-mono">{result.domain}</span> · Hash prefix:{' '}
            <span className="font-mono">{result.hash_prefix}</span>
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
