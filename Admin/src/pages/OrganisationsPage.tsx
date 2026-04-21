import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FieldShell, SelectField, TextAreaField, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useOrganisationsQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';
import { NewOrganisationFormSchema, type NewOrganisationFormValues } from '../schemas/admin';

export function OrganisationsPage() {
  const { data = [], isLoading } = useOrganisationsQuery();
  const navigate = useNavigate();
  const { confirm, openDialog, openUser } = useAdminUi();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { pageItems, pagination } = usePagination(data);

  return (
    <>
      <PageHeader title="Organisations" description="All organisations across all domains" actions={<Button icon="plus" variant="primary" onClick={() => setIsModalOpen(true)}>New Org</Button>} />
      <Card>
        <div className="flex gap-2 border-b border-gray-100 px-4 py-3">
          <TextField className="w-64" placeholder="Search organisations..." type="search" />
        </div>
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading organisations...</p>
        ) : (
          <>
            <DataTable headers={['Organisation', 'Owner', 'Members', 'Teams', 'Created', 'Actions']}>
              {pageItems.map((org) => (
                <tr
                  key={org.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                  tabIndex={0}
                  onClick={() => navigate(`/organisations/${org.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      navigate(`/organisations/${org.id}`);
                    }
                  }}
                >
                  <Td>
                    <div className="flex items-center gap-2">
                      <Avatar label={org.name} shape="square" />
                      <div>
                        <Link to={`/organisations/${org.id}`} className="text-sm font-semibold text-indigo-600 hover:text-indigo-900" onClick={(event) => event.stopPropagation()}>{org.name}</Link>
                        <p className="mt-0.5 text-xs text-gray-400">{org.slug}</p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <button className="text-left text-sm text-gray-700 hover:text-indigo-700" type="button" onClick={(event) => { event.stopPropagation(); openUser(org.owner.id); }}>{org.owner.name}</button>
                    <p className="text-xs text-gray-400">{org.owner.email}</p>
                  </Td>
                  <Td>{org.members.length}</Td>
                  <Td>{org.teams.length}</Td>
                  <Td className="text-xs text-gray-400">{org.created}</Td>
                  <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                    <ActionButton onClick={() => openDialog({ type: 'edit-org', organisation: org })}>Edit</ActionButton>
                    <ActionDivider />
                    <ActionButton tone="amber" onClick={() => openDialog({ type: 'transfer-ownership', organisation: org })}>Transfer</ActionButton>
                    <ActionDivider />
                    <ActionButton tone="red" onClick={() => confirm(`Delete ${org.name}?`, 'Deletes all teams and memberships in the sample UI.')}>Delete</ActionButton>
                  </Td>
                </tr>
              ))}
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
  const [preapproved, setPreapproved] = useState<Array<{ email: string; role: string }>>([]);
  const [preapproveEmail, setPreapproveEmail] = useState('');
  const [preapproveRole, setPreapproveRole] = useState('member');
  const form = useForm<NewOrganisationFormValues>({
    resolver: zodResolver(NewOrganisationFormSchema),
    defaultValues: { name: '', slug: '', description: '', ownerEmail: '' },
  });

  function submit() {
    onClose();
  }

  function addPreapproved() {
    const email = preapproveEmail.trim();

    if (!email || preapproved.some((entry) => entry.email === email)) {
      return;
    }

    setPreapproved((current) => [...current, { email, role: preapproveRole }]);
    setPreapproveEmail('');
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New Organisation"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={form.handleSubmit(submit)}>Create Organisation</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="Organisation name" error={form.formState.errors.name?.message}>
          <TextField
            {...form.register('name')}
            placeholder="Acme Engineering"
            onChange={(event) => {
              form.register('name').onChange(event);
              form.setValue('slug', slugify(event.target.value));
            }}
          />
        </FieldShell>
        <FieldShell label="Slug" hint="URL-safe identifier, auto-generated." error={form.formState.errors.slug?.message}>
          <TextField {...form.register('slug')} className="font-mono" placeholder="acme-engineering" />
        </FieldShell>
        <FieldShell label="Description">
          <TextAreaField {...form.register('description')} rows={2} placeholder="What does this organisation do?" />
        </FieldShell>
        <FieldShell label="Owner email" hint="Must be an existing user." error={form.formState.errors.ownerEmail?.message}>
          <TextField {...form.register('ownerEmail')} placeholder="owner@example.com" type="email" />
        </FieldShell>
        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-semibold text-gray-900">Pre-approved members</p>
          <p className="mt-1 text-xs text-gray-500">These email addresses receive membership when they first log in.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <TextField className="min-w-0 flex-1" value={preapproveEmail} placeholder="user@example.com" type="email" onChange={(event) => setPreapproveEmail(event.target.value)} />
            <SelectField value={preapproveRole} onChange={(event) => setPreapproveRole(event.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </SelectField>
            <Button onClick={addPreapproved}>Add</Button>
          </div>
          <div className="mt-3 space-y-1.5">
            {preapproved.length > 0 ? preapproved.map((entry) => (
              <div key={entry.email} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-gray-700">{entry.email}</span>
                <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">{entry.role}</span>
                <button className="text-gray-400 hover:text-red-600" type="button" onClick={() => setPreapproved((current) => current.filter((item) => item.email !== entry.email))}>Remove</button>
              </div>
            )) : <p className="text-sm text-gray-400">No pre-approved members yet.</p>}
          </div>
        </div>
      </form>
    </Modal>
  );
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
