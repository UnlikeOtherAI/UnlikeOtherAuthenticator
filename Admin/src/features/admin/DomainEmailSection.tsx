import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { adminService } from '../../services/admin-service';
import { useDomainEmailQuery } from './admin-queries';
import type { DomainEmailRegistration } from './types';

type DomainEmailSectionProps = {
  domain: string;
};

function StatusPill({ value }: { value: string | null | undefined }) {
  const tone = value === 'Success' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{value ?? 'Not registered'}</span>;
}

export function DomainEmailSection({ domain }: DomainEmailSectionProps) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useDomainEmailQuery(domain);
  const [registration, setRegistration] = useState<DomainEmailRegistration | null>(null);
  const [form, setForm] = useState({
    mailingDomain: '',
    fromAddress: '',
    fromName: '',
    replyToDefault: '',
  });

  useEffect(() => {
    if (!data?.config) return;
    setForm({
      mailingDomain: data.config.mailingDomain ?? '',
      fromAddress: data.config.fromAddress ?? '',
      fromName: data.config.fromName ?? '',
      replyToDefault: data.config.replyToDefault ?? '',
    });
  }, [data?.config]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'domain-email', domain] });
  };

  const save = useMutation({
    mutationFn: () => adminService.updateDomainEmail(domain, form),
    onSuccess: invalidate,
  });
  const register = useMutation({
    mutationFn: () => adminService.registerDomainEmail(domain),
    onSuccess: async (result) => {
      setRegistration(result);
      await invalidate();
    },
  });
  const refresh = useMutation({
    mutationFn: () => adminService.refreshDomainEmail(domain),
    onSuccess: invalidate,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => adminService.setDomainEmailEnabled(domain, enabled),
    onSuccess: invalidate,
  });

  const config = data?.config;
  const canEnable = config?.sesVerification === 'Success' && config.sesDkim === 'Success';

  return (
    <Card className="mt-5">
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Transactional email</h2>
          <p className="mt-0.5 text-xs text-gray-400">Configure SES-backed sending for this domain.</p>
        </div>
        <div className="flex gap-2">
          <StatusPill value={config?.sesVerification} />
          <StatusPill value={config?.sesDkim} />
        </div>
      </CardHeader>
      {isLoading ? (
        <p className="px-5 py-6 text-sm text-gray-400">Loading email settings...</p>
      ) : (
        <div className="space-y-4 p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <FieldShell label="Mailing domain">
              <TextField value={form.mailingDomain} onChange={(event) => setForm((current) => ({ ...current, mailingDomain: event.target.value }))} placeholder="mail.example.com" />
            </FieldShell>
            <FieldShell label="From address">
              <TextField value={form.fromAddress} onChange={(event) => setForm((current) => ({ ...current, fromAddress: event.target.value }))} placeholder="team@mail.example.com" />
            </FieldShell>
            <FieldShell label="From name">
              <TextField value={form.fromName} onChange={(event) => setForm((current) => ({ ...current, fromName: event.target.value }))} placeholder="Example Team" />
            </FieldShell>
            <FieldShell label="Default reply-to">
              <TextField value={form.replyToDefault} onChange={(event) => setForm((current) => ({ ...current, replyToDefault: event.target.value }))} placeholder="support@example.com" />
            </FieldShell>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
            <Button disabled={!data?.adminCredentialsConfigured || !config?.mailingDomain || register.isPending} onClick={() => register.mutate()}>Register sender</Button>
            <Button disabled={!data?.adminCredentialsConfigured || !config?.mailingDomain || refresh.isPending} onClick={() => refresh.mutate()}>Refresh status</Button>
            <Button disabled={!canEnable || toggle.isPending} onClick={() => toggle.mutate(!config?.enabled)}>
              {config?.enabled ? 'Disable sending' : 'Enable sending'}
            </Button>
          </div>
          {!data?.adminCredentialsConfigured ? (
            <p className="text-xs text-amber-700">Dedicated SES admin credentials are not configured. Register sender is disabled; already verified senders can still send when enabled.</p>
          ) : null}
          {!canEnable ? (
            <p className="text-xs text-gray-400">Sending can be enabled after SES verification and DKIM both report Success.</p>
          ) : null}
          {registration ? <DnsRecords registration={registration} /> : null}
        </div>
      )}
    </Card>
  );
}

function DnsRecords({ registration }: { registration: DomainEmailRegistration }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">DNS records</p>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-gray-700">
        {[registration.verification.record, ...registration.dkim.map((record) => `${record.cname} CNAME ${record.value}`)].join('\n')}
      </pre>
    </div>
  );
}
