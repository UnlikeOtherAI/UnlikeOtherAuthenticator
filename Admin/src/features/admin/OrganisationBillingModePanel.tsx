import { useState } from 'react';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { FieldShell, SelectField } from '../../components/ui/FormFields';
import type { BillingOrganisationMode } from '../../schemas/billing-organisation-mode';
import { billingOrganisationModeCopy } from './billing-organisation-mode-copy';
import { useBillingOrganisationMode } from './billing-organisation-mode-queries';

export function OrganisationBillingModePanel({ organisationId }: { organisationId: string }) {
  const { query, mutation } = useBillingOrganisationMode(organisationId);
  const [selection, setSelection] = useState<BillingOrganisationMode['mode'] | null>(null);
  const copy = billingOrganisationModeCopy();
  const data = query.data;
  const selected = selection ?? data?.mode ?? 'live';
  const blocked = (data?.blockers.length ?? 0) > 0;
  return <Card>
    <CardHeader><h2 className="text-sm font-semibold text-gray-900">{copy.title}</h2>
      {data ? <Badge variant={data.mode === 'sandbox' ? 'amber' : 'green'}>
        {data.mode === 'sandbox' ? copy.sandbox : copy.live}</Badge> : null}</CardHeader>
    <div className="space-y-4 p-5">
      <p className="max-w-2xl text-sm text-gray-600">{copy.description}</p>
      {query.isLoading ? <p className="text-sm text-gray-500">{copy.loading}</p> : null}
      {query.isError ? <div role="alert" className="text-sm text-red-600">{copy.loadError}{' '}
        <Button onClick={() => void query.refetch()}>{copy.retry}</Button></div> : null}
      {data ? <>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({ mode: selected, revision: data.revision }, { onSuccess: () => setSelection(null) });
        }}>
          <FieldShell label={copy.label}>
            <SelectField value={selected} disabled={blocked || mutation.isPending}
              onChange={(event) => { setSelection(event.target.value as BillingOrganisationMode['mode']); mutation.reset(); }}>
              <option value="live">{copy.live}</option><option value="sandbox">{copy.sandbox}</option>
            </SelectField>
          </FieldShell>
          <Button type="submit" variant="primary" disabled={blocked || selected === data.mode || mutation.isPending}>
            {mutation.isPending ? copy.saving : copy.save}</Button>
        </form>
        {mutation.isError ? <p role="alert" className="text-sm text-red-600">{copy.saveError}</p> : null}
        {mutation.isSuccess ? <p role="status" className="text-sm text-green-700">{copy.saved}</p> : null}
        {blocked ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p>{copy.blocked}</p><ul className="mt-2 list-inside list-disc">
            {data.blockers.map((blocker) => <li key={blocker.code}>
              {copy.blockers[blocker.code] ?? copy.title} ({blocker.count})</li>)}
          </ul></div> : null}
      </> : null}
      <p className="max-w-2xl text-sm text-gray-500">{copy.effect}</p>
    </div>
  </Card>;
}
