import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useDomainsQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';
import { adminService, type DomainSecretResponse } from '../services/admin-service';

export function SecretsPage() {
  const { data = [], isLoading } = useDomainsQuery();
  const { confirm, openDialog } = useAdminUi();
  const queryClient = useQueryClient();
  const [revealedSecret, setRevealedSecret] = useState<DomainSecretResponse | null>(null);
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
    mutationFn: adminService.rotateDomainSecret,
    onSuccess: (result) => {
      setRevealedSecret(result);
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
                        `Rotate ${domain.name}?`,
                        'A new domain client secret will be generated and the previous active secret will stop working.',
                        async () => {
                          await rotateSecret.mutateAsync(domain.name);
                        },
                      )}
                    >
                      Rotate
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
      <SecretModal result={revealedSecret} onClose={() => setRevealedSecret(null)} />
    </>
  );
}

function SecretModal({ onClose, result }: { onClose: () => void; result: DomainSecretResponse | null }) {
  return (
    <Modal
      isOpen={Boolean(result)}
      onClose={onClose}
      title="Client Secret"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4">
        <FieldShell label="Domain">
          <TextField readOnly value={result?.domain.name ?? ''} />
        </FieldShell>
        <FieldShell label="Client secret" hint="Store this in the client backend. It will not be shown again.">
          <TextField readOnly className="font-mono" value={result?.client_secret ?? ''} />
        </FieldShell>
        <FieldShell label="Client hash" hint="Use this hash as the backend Authorization bearer token.">
          <TextField readOnly className="font-mono" value={result?.client_hash ?? ''} />
        </FieldShell>
      </div>
    </Modal>
  );
}
