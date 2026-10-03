import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { useDirectoryParam } from '../features/admin/useDirectoryParam';
import { useState } from 'react';
import { Link } from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FieldShell, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useCreateOrganisationMutation, useOrganisationsQuery } from '../features/admin/admin-queries';
import { NewOrganisationFormSchema, type NewOrganisationFormValues } from '../schemas/admin';

export function OrganisationsPage() {
  const { data = [], isLoading, isError, refetch } = useOrganisationsQuery();
  const { recordState, openRecord } = useDirectoryNavigation('/organisations');
  const [search, setSearch] = useDirectoryParam('q');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { pageItems, pagination } = usePagination(data.filter((org) => [org.name, org.slug, org.owner.email].some((value) => value.toLowerCase().includes(search.trim().toLowerCase()))));

  return (
    <>
      <PageHeader title="Organisations" description="Search the latest 100 organisations." actions={<Button icon="plus" variant="primary" onClick={() => setIsModalOpen(true)}>New organisation</Button>} />
      <Card>
        <div className="flex gap-2 border-b border-gray-100 px-4 py-3">
          <TextField className="w-64" aria-label="Search organisations" placeholder="Search organisations..." type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        {isError ? <div role="alert" className="p-5">Could not load organisations. <Button onClick={() => void refetch()}>Retry</Button></div> : isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading organisations...</p>
        ) : (
          <>
            <DataTable headers={['Organisation', 'Owner', 'Members', 'Teams', 'Created']}>
              {pageItems.map((org) => (
                <tr
                  key={org.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                  tabIndex={0}
                  onClick={() => openRecord(`/organisations/${org.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && event.target === event.currentTarget) {
                      openRecord(`/organisations/${org.id}`);
                    }
                  }}
                >
                  <Td>
                    <div className="flex items-center gap-2">
                      <Avatar label={org.name} shape="square" />
                      <div>
                        <Link state={recordState} to={`/organisations/${org.id}`} className="text-sm font-semibold text-indigo-600 hover:text-indigo-900" onClick={(event) => event.stopPropagation()}>{org.name}</Link>
                        <p className="mt-0.5 text-xs text-gray-400">{org.slug}</p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {org.owner.id ? <Link state={recordState} className="text-indigo-600" to={`/users/${org.owner.id}`} onClick={(event) => event.stopPropagation()}>{org.owner.name ?? org.owner.email}</Link> : <span>Owner unavailable</span>}
                    <p className="text-xs text-gray-400">{org.owner.email}</p>
                  </Td>
                  <Td>{org.members.length}</Td>
                  <Td>{org.teams.length}</Td>
                  <Td className="text-xs text-gray-400">{org.created}</Td>

                </tr>
              ))}
            {pageItems.length === 0 ? <tr><Td colSpan={5}>No organisations match this search.</Td></tr> : null}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
      <NewOrganisationModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </>
  );
}

function NewOrganisationModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const mutation = useCreateOrganisationMutation();
  const form = useForm<Pick<NewOrganisationFormValues, 'name' | 'domain' | 'ownerEmail'>>({
    resolver: zodResolver(NewOrganisationFormSchema.pick({ name: true, domain: true, ownerEmail: true })),
    defaultValues: { name: '', domain: '', ownerEmail: '' },
  });

  async function submit(values: Pick<NewOrganisationFormValues, 'name' | 'domain' | 'ownerEmail'>) {
    try {
      await mutation.mutateAsync({
      name: values.name,
      domain: values.domain,
      ownerEmail: values.ownerEmail,
    });
    form.reset();
      onClose();
    } catch { /* Keep the form and values available for retry. */ }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { if (!mutation.isPending) onClose(); }}
      title="New Organisation"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" disabled={mutation.isPending} onClick={form.handleSubmit(submit)}>
            {mutation.isPending ? 'Creating...' : 'Create Organisation'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="Organisation name" error={form.formState.errors.name?.message}>
          <TextField
            {...form.register('name')}
            placeholder="Acme Engineering"

          />
        </FieldShell>
        <FieldShell label="Domain" hint="Primary domain for this organisation." error={form.formState.errors.domain?.message}>
          <TextField {...form.register('domain')} className="font-mono" placeholder="app.example.com" />
        </FieldShell>
        <FieldShell label="Owner email" hint="Must be an existing user." error={form.formState.errors.ownerEmail?.message}>
          <TextField {...form.register('ownerEmail')} placeholder="owner@example.com" type="email" />
        </FieldShell>
        {mutation.isError ? <p className="text-sm text-red-600">Could not create the organisation.</p> : null}
      </form>
    </Modal>
  );
}
