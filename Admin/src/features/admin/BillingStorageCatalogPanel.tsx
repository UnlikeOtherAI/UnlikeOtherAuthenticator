import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { DataTable, Td } from '../../components/ui/Table';
import { useStorageCatalogs, useBindStorageCatalog } from './billing-commercial-queries';
const schema = z.object({ currency: z.enum(['EUR', 'GBP', 'USD']), price_id: z.string().regex(/^price_[A-Za-z0-9]+$/, 'Enter an existing Stripe price ID.') });
export function BillingStorageCatalogPanel({ serviceId }: { serviceId: string }) {
  const list = useStorageCatalogs(serviceId), bind = useBindStorageCatalog(serviceId);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { currency: 'EUR', price_id: '' } });
  return <section className="space-y-3 border-t border-gray-200 pt-4">
    <h3 className="font-semibold text-gray-900">Storage price binding</h3>
    <p className="text-sm text-gray-500">Bind existing monthly prices on the configured Stripe account and mode. One decimal TB costs EUR 9.99, GBP 8.49 or USD 10.99 monthly.</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={form.handleSubmit(async (input) => {
      try { await bind.mutateAsync(input); } catch { /* Keep values for retry. */ }
    })}>
      <FieldShell label="Currency"><SelectField {...form.register('currency')}><option>EUR</option><option>GBP</option><option>USD</option></SelectField></FieldShell>
      <FieldShell label="Existing Stripe price" error={form.formState.errors.price_id?.message}><TextField {...form.register('price_id')} placeholder="price_..." /></FieldShell>
      <Button type="submit" disabled={bind.isPending}>Verify and bind price</Button>
    </form>
    {bind.isError ? <p role="alert" className="text-sm text-red-600">Price binding failed. Check account, mode, amount and whole-TB metadata.</p> : null}
    {bind.isSuccess ? <p role="status" className="text-sm text-green-700">Immutable storage price bound.</p> : null}
    {list.isError ? <p role="alert">Could not load price bindings. <Button onClick={() => void list.refetch()}>Retry</Button></p> : null}
    <DataTable headers={['Currency', 'Monthly minor units / TB', 'Price', 'Account']}>
      {(list.data ?? []).map((row) => <tr key={row.id}><Td>{row.currency}</Td><Td>{row.unit_amount_minor}</Td><Td>{row.price_id}</Td><Td>{row.account_id}</Td></tr>)}
      {list.data?.length === 0 ? <tr><Td colSpan={4}>Storage setup requires a verified price binding.</Td></tr> : null}
    </DataTable>
  </section>;
}
