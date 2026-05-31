import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '../ui/Button';
import { FieldShell, SelectField, TextField } from '../ui/FormFields';
import { Modal } from '../ui/Modal';
import { adminService } from '../../services/admin-service';
import type { Domain } from '../../features/admin/types';
import { AllowedEmailDomainsField } from '../sections/AllowedEmailDomainsField';
import { DomainSigningKeysSection } from '../sections/DomainSigningKeysSection';

type DomainFormState = {
  label: string;
  status: 'active' | 'disabled';
  allowedEmailDomains: string[];
};

export function EditDomainDialog({ domain, onClose, open }: { domain: Domain | null; onClose: () => void; open: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<DomainFormState>({ label: '', status: 'active', allowedEmailDomains: [] });
  const updateDomain = useMutation({
    mutationFn: (input: { domain: string; values: DomainFormState }) =>
      adminService.updateDomain(input.domain, input.values),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });

  useEffect(() => {
    if (!domain) return;
    setForm({
      label: domain.label,
      status: domain.status === 'disabled' ? 'disabled' : 'active',
      allowedEmailDomains: domain.allowedEmailDomains,
    });
  }, [domain]);

  async function submit() {
    if (!domain) return;
    await updateDomain.mutateAsync({ domain: domain.name, values: form });
    onClose();
  }

  return (
    <Modal
      isOpen={open && Boolean(domain)}
      onClose={onClose}
      title="Edit Domain"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="check" variant="primary" onClick={submit}>Save changes</Button>
        </>
      }
    >
      {domain ? (
        <div className="space-y-5">
          <FieldShell label="Domain name" hint="Must match the domain claim in config JWTs.">
            <TextField disabled value={domain.name} />
          </FieldShell>
          <FieldShell label="Friendly name">
            <TextField value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </FieldShell>
          <FieldShell label="Status">
            <SelectField
              value={form.status}
              onChange={(event) => setForm({ ...form, status: event.target.value === 'disabled' ? 'disabled' : 'active' })}
            >
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </SelectField>
          </FieldShell>
          <FieldShell
            label="Login email-domain restriction"
            hint="Only users whose email domain matches one of these can sign in to this domain. Empty = no restriction. Superusers always bypass."
          >
            <AllowedEmailDomainsField
              value={form.allowedEmailDomains}
              onChange={(next) => setForm({ ...form, allowedEmailDomains: next })}
            />
          </FieldShell>
          <DomainSigningKeysSection domain={domain.name} />
        </div>
      ) : null}
    </Modal>
  );
}
