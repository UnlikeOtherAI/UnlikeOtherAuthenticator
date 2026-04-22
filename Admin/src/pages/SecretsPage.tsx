import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { SelectField, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useDomainsQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';
import { adminService, type DomainRotateResponse } from '../services/admin-service';

export function SecretsPage() {
  const { data = [], isLoading } = useDomainsQuery();
  const { confirm, openDialog } = useAdminUi();
  const queryClient = useQueryClient();
  const [rotateResult, setRotateResult] = useState<DomainRotateResponse | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const filteredDomains = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return data.filter((domain) => {
      const matchesQuery = !normalized || [domain.name, domain.label, domain.hash].some((value) => value.toLowerCase().includes(normalized));
      const matchesStatus = status === 'all' || domain.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [data, query, status]);
  const { pageItems, pagination } = usePagination(filteredDomains);
  const updateStatus = useMutation({
    mutationFn: (input: { domain: string; status: 'active' | 'disabled' }) =>
      adminService.updateDomain(input.domain, { status: input.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const rotateSecret = useMutation({
    mutationFn: (input: { domain: string; deliveryMode: 'email' | 'reveal' }) =>
      adminService.rotateDomainSecret(input.domain, input.deliveryMode),
    onSuccess: (result) => {
      setRotateResult(result);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Secrets"
        description="Registered client domains. New domains are onboarded via the New Integrations queue."
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-gray-100 px-4 py-3">
          <TextField className="w-60" placeholder="Filter by domain..." type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          <SelectField value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </SelectField>
        </div>
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading domains...</p>
        ) : (
          <>
            <DataTable headers={['Domain', 'Client Hash', 'Secret Age', 'Users', 'Orgs', 'Status', 'Actions']}>
              {pageItems.map((domain) => (
                <tr
                  key={domain.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                  tabIndex={0}
                  onClick={() => openDialog({ type: 'edit-domain', domain })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      openDialog({ type: 'edit-domain', domain });
                    }
                  }}
                >
                  <Td>
                    <p className="font-medium text-gray-900">{domain.name}</p>
                    <p className="mt-0.5 text-xs text-gray-400">{domain.label} · Added {domain.created}</p>
                  </Td>
                  <Td><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{domain.hash}</code></Td>
                  <Td>{domain.secretAge ? <Badge variant={domain.secretOld ? 'amber' : 'green'}>{domain.secretAge}</Badge> : <Badge>—</Badge>}</Td>
                  <Td>{domain.users}</Td>
                  <Td>{domain.orgs}</Td>
                  <Td><StatusBadge status={domain.status} /></Td>
                  <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                    <ActionButton
                      tone="amber"
                      onClick={() => confirm(
                        `Email claim link for ${domain.name}?`,
                        'A one-time claim link will be emailed to the partner contact. The current secret keeps working until the partner claims the new one.',
                        async () => {
                          await rotateSecret.mutateAsync({ domain: domain.name, deliveryMode: 'email' });
                        },
                      )}
                    >
                      Rotate
                    </ActionButton>
                    <ActionDivider />
                    <ActionButton
                      tone="amber"
                      onClick={() => confirm(
                        `Rotate ${domain.name} and reveal the new secret?`,
                        'A fresh secret will be generated and shown in the admin UI once. No email is sent — deliver the credentials to the partner through your own secure channel. The current secret keeps working until the partner switches to the new one.',
                        async () => {
                          await rotateSecret.mutateAsync({ domain: domain.name, deliveryMode: 'reveal' });
                        },
                      )}
                    >
                      Rotate &amp; reveal
                    </ActionButton>
                    <ActionDivider />
                    <ActionButton
                      tone="red"
                      onClick={() => confirm(
                        `${domain.status === 'active' ? 'Disable' : 'Enable'} ${domain.name}?`,
                        domain.status === 'active' ? 'Domain bearer auth will be rejected for this domain.' : 'Domain bearer auth will be accepted again for active secrets.',
                        async () => {
                          await updateStatus.mutateAsync({
                            domain: domain.name,
                            status: domain.status === 'active' ? 'disabled' : 'active',
                          });
                        },
                      )}
                    >
                      {domain.status === 'active' ? 'Disable' : 'Enable'}
                    </ActionButton>
                  </Td>
                </tr>
              ))}
              {pageItems.length === 0 ? (
                <tr>
                  <Td colSpan={7} className="text-sm text-gray-400">No domains match the filters.</Td>
                </tr>
              ) : null}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
      <RotateNoticeModal result={rotateResult} onClose={() => setRotateResult(null)} />
    </>
  );
}

function RotateNoticeModal({
  onClose,
  result,
}: {
  onClose: () => void;
  result: DomainRotateResponse | null;
}) {
  const reveal = result?.delivery_mode === 'reveal' && result.credentials;
  const dispatched = result?.email_dispatched ?? false;
  const title = reveal
    ? 'New credentials (shown once)'
    : dispatched
    ? 'Rotation claim sent'
    : 'Rotation claim not delivered';
  const description = reveal
    ? `Copy the secret below now — it will not be displayed again. The previous secret keeps working until the partner switches to the new one. Deliver these to ${result?.contact_email ?? 'the partner contact'} through your own secure channel.`
    : dispatched
    ? `A one-time claim link has been emailed to ${result?.contact_email ?? 'the partner contact'}. The previous secret stays active until they open the link and confirm.`
    : `A claim token was created but the email to ${result?.contact_email ?? 'the partner contact'} could not be dispatched. Retry the rotation or deliver the link out-of-band.`;

  return (
    <Modal
      isOpen={Boolean(result)}
      onClose={onClose}
      title={title}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-3 text-sm text-gray-600">
        <p>{description}</p>
        {result?.credentials ? (
          <dl className="grid grid-cols-1 gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs">
            <div>
              <dt className="font-semibold text-amber-900">domain</dt>
              <dd className="break-all font-mono text-gray-800">{result.credentials.domain}</dd>
            </div>
            <div>
              <dt className="font-semibold text-amber-900">client_secret</dt>
              <dd className="break-all font-mono text-gray-800">{result.credentials.client_secret}</dd>
            </div>
            <div>
              <dt className="font-semibold text-amber-900">client_hash</dt>
              <dd className="break-all font-mono text-gray-800">{result.credentials.client_hash}</dd>
            </div>
            <div>
              <dt className="font-semibold text-amber-900">hash_prefix</dt>
              <dd className="break-all font-mono text-gray-800">{result.credentials.hash_prefix}</dd>
            </div>
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
