import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

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
import { DomainFormSchema, type DomainFormValues } from '../schemas/admin';

export function DomainsPage() {
  const { data = [], isLoading } = useDomainsQuery();
  const { confirm, openDialog } = useAdminUi();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { pageItems, pagination } = usePagination(data);

  return (
    <>
      <PageHeader title="Domains & Secrets" description="Registered client domains and access secrets" actions={<Button icon="plus" variant="primary" onClick={() => setIsModalOpen(true)}>Add Domain</Button>} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-gray-100 px-4 py-3">
          <TextField className="w-60" placeholder="Filter by domain..." type="search" />
          <SelectField>
            <option>All</option>
            <option>Active</option>
            <option>Disabled</option>
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
                    <ActionButton onClick={() => openDialog({ type: 'edit-domain', domain })}>Edit</ActionButton>
                    <ActionDivider />
                    <ActionButton tone="amber" onClick={() => confirm(`Rotate ${domain.name}?`, 'The new shared secret will need to be deployed by the client backend.')}>Rotate</ActionButton>
                    <ActionDivider />
                    <ActionButton tone="red" onClick={() => confirm(`${domain.status === 'active' ? 'Disable' : 'Enable'} ${domain.name}?`, 'This is mocked until the admin API is available.')}>{domain.status === 'active' ? 'Disable' : 'Enable'}</ActionButton>
                  </Td>
                </tr>
              ))}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
      <AddDomainModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </>
  );
}

function AddDomainModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const secret = useMemo(generateSecret, [isOpen]);
  const form = useForm<DomainFormValues>({
    resolver: zodResolver(DomainFormSchema),
    values: { domain: '', label: '', secret },
  });

  function submit() {
    onClose();
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Domain"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={form.handleSubmit(submit)}>Add Domain</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="Domain name" hint="Must match the domain claim in config JWTs." error={form.formState.errors.domain?.message}>
          <TextField {...form.register('domain')} placeholder="app.example.com" />
        </FieldShell>
        <FieldShell label="Friendly name" error={form.formState.errors.label?.message}>
          <TextField {...form.register('label')} placeholder="My App" />
        </FieldShell>
        <FieldShell label="Client secret" hint="The client backend sets this as SHARED_SECRET." error={form.formState.errors.secret?.message}>
          <div className="flex gap-2">
            <TextField {...form.register('secret')} className="font-mono" />
            <Button onClick={() => form.setValue('secret', generateSecret())}>Generate</Button>
          </div>
        </FieldShell>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Store this secret securely. It will not be shown again after saving.</div>
      </form>
    </Modal>
  );
}

function generateSecret() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 48 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
