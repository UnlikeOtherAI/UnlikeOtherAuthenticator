import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell } from '../../components/ui/FormFields';
import { AllowedEmailDomainsField } from '../../components/sections/AllowedEmailDomainsField';
import { AllowedEmailsField } from '../../components/sections/AllowedEmailsField';
import { AllowedRedirectUrlsField } from '../../components/sections/AllowedRedirectUrlsField';
import { adminService } from '../../services/admin-service';
import { DOMAIN_TWOFA_POLICY_OPTIONS, isDomainTwoFaPolicy, TwoFactorPolicySelect } from './TwoFactorPolicySelect';
import type { TwoFaPolicy } from './types';
import type { Domain } from './types';

type AccessForm = {
  allowedEmailDomains: string[];
  allowedEmails: string[];
  allowedRedirectUrls: string[];
  deviceLoginConfigUrls: string[];
};

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function DomainAccessTab({ domain }: { domain: Domain }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AccessForm>(toForm(domain));
  const [deviceUrlsText, setDeviceUrlsText] = useState((domain.deviceLoginConfigUrls ?? []).join("\n"));
  const [error, setError] = useState(false);

  useEffect(() => {
    setForm(toForm(domain));
    setDeviceUrlsText((domain.deviceLoginConfigUrls ?? []).join("\n"));
  }, [domain]);

  const save = useMutation({
    mutationFn: (values: AccessForm) => adminService.updateDomain(domain.name, values),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
    onError: () => setError(true),
  });

  const policy = useMutation({
    mutationFn: (twoFaPolicy: TwoFaPolicy) => adminService.updateDomain(domain.name, { twoFaPolicy }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });

  const deviceLoginConfigUrls = deviceUrlsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const dirty =
    !sameList(form.allowedEmailDomains, domain.allowedEmailDomains) ||
    !sameList(form.allowedEmails, domain.allowedEmails) ||
    !sameList(form.allowedRedirectUrls, domain.allowedRedirectUrls) ||
    !sameList(deviceLoginConfigUrls, domain.deviceLoginConfigUrls ?? []);

  function submit() {
    setError(false);
    save.mutate({ ...form, deviceLoginConfigUrls });
  }

  return (
    <div className="space-y-5">
      <TwoFactorPolicySelect title="Two-factor authentication" description="The strongest service and organisation policy applies at sign-in." value={domain.twoFaPolicy} options={DOMAIN_TWOFA_POLICY_OPTIONS} saving={policy.isPending} onSave={(next) => isDomainTwoFaPolicy(next) ? policy.mutateAsync(next) : Promise.resolve()} />
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
          always bypass. A listed email or domain also lets that person sign in even when the service has registration
          disabled — so this list doubles as an explicit allow-list for invited users.
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

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-gray-900">Numeric device sign-in</h3>
        <p className="mt-0.5 text-xs text-gray-500">
          Off when empty. Add each exact HTTPS signed config URL on its own line. A signed-in browser
          must approve the matching device claim before UOA issues a new session.
        </p>
        <label className="mt-4 block text-sm font-medium text-gray-700" htmlFor="device-login-config-urls">
          Enabled site config URLs
        </label>
        <textarea id="device-login-config-urls" rows={3}
          className="mt-1 w-full rounded border border-gray-300 p-2 font-mono text-sm"
          value={deviceUrlsText}
          onChange={(event) => setDeviceUrlsText(event.target.value)} />
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
    deviceLoginConfigUrls: domain.deviceLoginConfigUrls ?? [],
  };
}
