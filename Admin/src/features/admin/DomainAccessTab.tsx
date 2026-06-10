import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell } from '../../components/ui/FormFields';
import { AllowedEmailDomainsField } from '../../components/sections/AllowedEmailDomainsField';
import { AllowedEmailsField } from '../../components/sections/AllowedEmailsField';
import { AllowedRedirectUrlsField } from '../../components/sections/AllowedRedirectUrlsField';
import { adminService } from '../../services/admin-service';
import type { Domain } from './types';

type AccessForm = {
  allowedEmailDomains: string[];
  allowedEmails: string[];
  allowedRedirectUrls: string[];
};

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function DomainAccessTab({ domain }: { domain: Domain }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AccessForm>(toForm(domain));
  const [error, setError] = useState(false);

  useEffect(() => {
    setForm(toForm(domain));
  }, [domain]);

  const save = useMutation({
    mutationFn: (values: AccessForm) => adminService.updateDomain(domain.name, values),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
    onError: () => setError(true),
  });

  const dirty =
    !sameList(form.allowedEmailDomains, domain.allowedEmailDomains) ||
    !sameList(form.allowedEmails, domain.allowedEmails) ||
    !sameList(form.allowedRedirectUrls, domain.allowedRedirectUrls);

  function submit() {
    setError(false);
    save.mutate(form);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">Changes to login access and redirect URLs apply on the next sign-in.</p>
        <Button icon="check" variant="primary" size="sm" disabled={!dirty || save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-gray-900">Login access whitelist</h3>
        <p className="mt-0.5 text-xs text-gray-500">
          Empty = no restriction. A user may sign in if their email domain OR their exact email is listed. Superusers
          always bypass.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <FieldShell label="Allowed email domains">
            <AllowedEmailDomainsField
              value={form.allowedEmailDomains}
              onChange={(next) => setForm((current) => ({ ...current, allowedEmailDomains: next }))}
            />
          </FieldShell>
          <FieldShell label="Allowed individual emails">
            <AllowedEmailsField
              value={form.allowedEmails}
              onChange={(next) => setForm((current) => ({ ...current, allowedEmails: next }))}
            />
          </FieldShell>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-gray-900">Allowed redirect URLs</h3>
        <p className="mt-0.5 text-xs text-gray-500">
          Extra redirect targets permitted for this domain, in addition to those declared in the client&apos;s signed
          config. Matched byte-for-byte; empty = no additions.
        </p>
        <div className="mt-4">
          <FieldShell label="Redirect URLs">
            <AllowedRedirectUrlsField
              value={form.allowedRedirectUrls}
              onChange={(next) => setForm((current) => ({ ...current, allowedRedirectUrls: next }))}
            />
          </FieldShell>
        </div>
      </Card>

      {error ? (
        <p className="text-xs text-red-600">Could not save. Check the domains, emails, and URLs and try again.</p>
      ) : null}
    </div>
  );
}

function toForm(domain: Domain): AccessForm {
  return {
    allowedEmailDomains: domain.allowedEmailDomains,
    allowedEmails: domain.allowedEmails,
    allowedRedirectUrls: domain.allowedRedirectUrls,
  };
}
