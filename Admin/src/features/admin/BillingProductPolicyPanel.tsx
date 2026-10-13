import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { DataTable, Td } from '../../components/ui/Table';
import type { BillingService } from '../../schemas/billing';
import { ApiRequestError } from '../../services/api-client';
import { useOrganisationsQuery } from './admin-queries';
import { useProductPolicies, useSaveProductPolicy } from './billing-commercial-queries';
import { BillingStorageCatalogPanel } from './BillingStorageCatalogPanel';
import { BillingSeatOffersPanel } from './BillingSeatOffersPanel';

const schema = z.object({ organisation: z.string().min(1, 'Select a company.'),
  source: z.string().min(1, 'Enter the registered source domain.'), timezone: z.string().min(1),
  policy: z.enum(['standard', 'trial', 'private']), end: z.string() });
const errors: Record<string, string> = {
  BILLING_PRIVATE_RETAIL_STORAGE_ACTIVE: 'End the retail storage subscription and revoke its automatic expansion mandate before assigning private pricing.',
  BILLING_PRIVATE_COLLECTING_TARIFF_REQUIRED: 'Assign an at-cost company tariff with zero monthly fee and enabled cost collection first.',
  BILLING_PRIVATE_TEAM_OVERRIDE_CONFLICT: 'Remove conflicting team tariff overrides before assigning private company pricing.',
  BILLING_CUSTOM_TRIAL_PARTIAL_WAIVER_UNSUPPORTED: 'This accepted flat or full-month agreement cannot receive a partial trial waiver.',
  BILLING_PRIVATE_TRANSITION_TERMS_REQUIRED: 'Stage the replacement company tariff first; private pricing ends on its effective month.',
  BILLING_COMMERCIAL_SOURCE_IMMUTABLE: 'This company is already enrolled to another product source.',
};
export function BillingProductPolicyPanel({ service }: { service: BillingService }) {
  const organisations = useOrganisationsQuery();
  const list = useProductPolicies(service.id);
  const save = useSaveProductPolicy(service.id);
  const [effective, setEffective] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema),
    defaultValues: { organisation: '', source: '', timezone: 'UTC', policy: 'standard', end: '' } });
  const sources = [...new Set(service.app_keys.map((key) => {
    const issuer = new URL(key.actor_issuer); return `${issuer.host}${issuer.pathname.replace(/\/$/, '')}`;
  }))];
  async function submit(input: z.infer<typeof schema>) {
    try {
      const result = await save.mutateAsync({ organisation_id: input.organisation, source_domain: input.source,
        billing_timezone: input.timezone, private_at_cost: input.policy === 'private', start_trial: input.policy === 'trial',
        ...(input.policy === 'trial' && input.end ? { trial_ends_at: new Date(`${input.end}Z`).toISOString() } : {}) });
      setEffective(result.effective_at);
    } catch { /* Preserve the proposed company action and show its exact rejection. */ }
  }
  return <div className="space-y-5 px-5 py-4">
    <div><h3 className="font-semibold text-gray-900">Company access and trials</h3>
      <p className="mt-1 text-sm text-gray-500">Assign an exact company. Trials waive seat fees; inference, phone, SMS and storage remain payable.</p></div>
    <form onSubmit={form.handleSubmit(submit)} className="grid gap-4 sm:grid-cols-2">
      <FieldShell label="Company" error={form.formState.errors.organisation?.message}>
        <SelectField {...form.register('organisation')} className="w-full"><option value="">Select company</option>
          {(organisations.data ?? []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</SelectField>
      </FieldShell>
      <FieldShell label="Registered product source" error={form.formState.errors.source?.message}>
        <SelectField {...form.register('source')} className="w-full"><option value="">Select source</option>
          {sources.map((source) => <option key={source} value={source}>{source}</option>)}</SelectField>
      </FieldShell>
      <FieldShell label="Billing timezone" hint="IANA timezone; weekends pause seat/storage grace.">
        <TextField {...form.register('timezone')} placeholder="Europe/London" /></FieldShell>
      <FieldShell label="Company policy"><SelectField {...form.register('policy')} className="w-full">
        <option value="standard">Standard agreement access</option><option value="trial">Start company trial</option>
        <option value="private">Private company at cost</option></SelectField></FieldShell>
      {form.watch('policy') === 'trial' ? <FieldShell label="Trial end (UTC)" hint="Blank defaults to one calendar month. Expiry does not accept a paid subscription.">
        <TextField type="datetime-local" {...form.register('end')} /></FieldShell> : null}
      <div className="sm:col-span-2"><Button type="submit" variant="primary" disabled={save.isPending}>Save company policy</Button></div>
    </form>
    {save.isError ? <p role="alert" className="text-sm text-red-600">{save.error instanceof ApiRequestError
      ? errors[save.error.code ?? ''] ?? `Could not save policy (${save.error.code ?? save.error.status}).` : 'Could not save policy.'}</p> : null}
    {effective ? <p role="status" className="text-sm text-green-700">Policy takes effect {new Date(effective).toUTCString()}.</p> : null}
    {list.isError ? <p role="alert">Could not load company policies. <Button onClick={() => void list.refetch()}>Retry</Button></p> : null}
    <DataTable headers={['Company', 'Source', 'Timezone', 'Policy', 'Effective', 'Trial end']}>
      {(list.data ?? []).map((row) => <tr key={row.id}><Td>{organisations.data?.find((org) => org.id === row.organisation_id)?.name ?? row.organisation_id}</Td>
        <Td>{row.source_domain}</Td><Td>{row.billing_timezone}</Td><Td>{row.policy?.privateAtCost ? 'Private at cost' : row.policy?.trialEndsAt ? 'Trial' : 'Standard'}</Td>
        <Td>{row.policy ? new Date(row.policy.effectiveAt).toUTCString() : 'Enrolled'}</Td>
        <Td>{row.policy?.trialEndsAt ? new Date(row.policy.trialEndsAt).toUTCString() : '—'}</Td></tr>)}
      {list.data?.length === 0 ? <tr><Td colSpan={6}>No companies enrolled for this product.</Td></tr> : null}
    </DataTable>
    {service.identifier === 'nessie' ? <BillingStorageCatalogPanel serviceId={service.id} /> : null}
    {service.identifier === 'nessie' ? <BillingSeatOffersPanel service={service} /> : null}
  </div>;
}
