import { useState } from 'react';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, Td } from '../../components/ui/Table';
import type { BillingService } from '../../schemas/billing';
import { useAdminUi } from '../shell/admin-ui';
import { BillingLedgerRuntimeKeyDialog } from './BillingLedgerRuntimeKeyDialog';
import { useBillingLedgerRuntimeKeysQuery,
  useRevokeBillingLedgerRuntimeKeyMutation } from './billing-ledger-runtime-key-queries';

export function BillingLedgerRuntimeKeysPanel({ service }: { service: BillingService }) {
  const list = useBillingLedgerRuntimeKeysQuery();
  const revoke = useRevokeBillingLedgerRuntimeKeyMutation();
  const { confirm } = useAdminUi();
  const [open, setOpen] = useState(false);
  const keys = list.data?.filter((key) => key.product === service.identifier) ?? [];
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <p className="max-w-2xl text-sm text-gray-500">
          Ledger uses these product-bound keys to reserve credits and recover authorized job compute.
          Each key fixes the original source domain and exact Ledger audience.
        </p>
        <Button icon="key" variant="primary" disabled={!service.active}
          onClick={() => setOpen(true)}>Issue runtime key</Button>
      </div>
      {list.isLoading ? <p className="px-5 pb-4 text-sm text-gray-500">Loading runtime keys...</p> : null}
      {list.isError ? <div role="alert" className="px-5 pb-4 text-sm text-red-600">
        Could not load runtime keys. <Button onClick={() => void list.refetch()}>Retry</Button>
      </div> : null}
      {!list.isLoading && !list.isError ? <DataTable
        headers={['Prefix / ID', 'Source domain', 'Ledger audience', 'Created', 'Status', '']}>
        {keys.map((key) => <tr key={key.id}>
          <Td><code className="text-xs">{key.key_prefix}</code>
            <p className="max-w-48 break-all text-xs text-gray-400">{key.id}</p></Td>
          <Td><code className="block min-w-40 max-w-48 break-all text-xs">{key.source_domain}</code></Td>
          <Td><code className="block min-w-64 max-w-64 break-all text-xs">{key.ledger_audience}</code></Td>
          <Td className="text-xs">{new Date(key.created_at).toLocaleString()}</Td>
          <Td><Badge variant={key.revoked_at ? 'red' : 'green'}>
            {key.revoked_at ? 'Revoked' : 'Active'}</Badge>
            {key.revoked_at ? <p className="mt-1 text-xs text-gray-400">
              {new Date(key.revoked_at).toLocaleString()}</p> : null}</Td>
          <Td><Button size="sm" variant="danger" disabled={!!key.revoked_at || revoke.isPending}
            onClick={() => confirm(`Revoke runtime key ${key.key_prefix}?`,
              `Requests using this key for ${service.identifier} from ${key.source_domain} will lose Ledger admission and job-compute authorization at ${key.ledger_audience}. This cannot be undone.`,
              async () => { await revoke.mutateAsync(key.id); })}>Revoke</Button></Td>
        </tr>)}
        {keys.length === 0 ? <tr><Td colSpan={6} className="text-gray-400">
          No Ledger runtime keys have been issued for {service.name}.</Td></tr> : null}
      </DataTable> : null}
      {open ? <BillingLedgerRuntimeKeyDialog service={service}
        onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
