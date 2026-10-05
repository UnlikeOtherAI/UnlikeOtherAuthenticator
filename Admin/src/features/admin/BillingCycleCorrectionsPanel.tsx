import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { useBillingCycleCorrectionsQuery,
  usePrepareBillingCycleCorrectionMutation } from './billing-contract-queries';

/** Closed-month correction doorway inside the one Contracts & invoices home. */
export function BillingCycleCorrectionsPanel({ onInvoicePrepared }: {
  onInvoicePrepared: (invoiceId: string) => void;
}) {
  const candidates = useBillingCycleCorrectionsQuery();
  const prepare = usePrepareBillingCycleCorrectionMutation();
  if (candidates.isLoading || candidates.data?.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Late billing corrections</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Review changed closed-month usage before issuing a supplemental document.
          </p>
        </div>
      </CardHeader>
      {candidates.isError ? <p role="alert" className="p-5 text-sm text-red-600">
        Billing corrections could not be loaded.
      </p> : null}
      <div className="divide-y divide-gray-200">
        {(candidates.data ?? []).map((item) => (
          <div key={item.cycle_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-gray-900">{item.billing_month} · {item.service_id}</p>
              <p className="text-gray-500">Organisation {item.organisation_id} ·
                {item.direction === 'debit' ? ' Additional charge' :
                  item.direction === 'credit' ? ' Credit note required' :
                    ' Evidence under review'}</p>
            </div>
            {item.supplement_invoice_id ? (
              <Button size="sm" variant="secondary"
                onClick={() => {
                  if (item.supplement_invoice_id) onInvoicePrepared(item.supplement_invoice_id);
                }}>
                View supplemental invoice
              </Button>
            ) : item.direction === 'debit' ? (
              <Button size="sm" variant="secondary" disabled={prepare.isPending}
                onClick={async () => {
                  try {
                    const invoice = await prepare.mutateAsync(item.cycle_id);
                    onInvoicePrepared(invoice.id);
                  } catch {
                    // Keep the row and source error visible for a corrected retry.
                  }
                }}>
                Prepare supplement
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      {prepare.isError ? <p role="alert" className="px-5 pb-4 text-sm text-red-600">
        {prepare.error instanceof Error ? prepare.error.message :
          'The correction could not be prepared.'}
      </p> : null}
    </Card>
  );
}
