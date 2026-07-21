import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { DataTable, Td } from '../../components/ui/Table';
import type { BillingInvoice } from '../../schemas/billing-contracts';

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function statusVariant(status: BillingInvoice['status']) {
  if (status === 'issued') return 'green' as const;
  if (status === 'void') return 'red' as const;
  return 'slate' as const;
}

export function BillingInvoiceHistory({
  invoices,
  onSelect,
}: {
  invoices: BillingInvoice[];
  onSelect: (invoiceId: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Invoice history</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Drafts, issued PDFs, payments, refunds, write-offs, and voids.
          </p>
        </div>
        <Badge variant="slate">{invoices.length} invoices</Badge>
      </CardHeader>
      {invoices.length === 0 ? (
        <p className="p-8 text-center text-sm text-gray-500">
          No invoices have been calculated yet.
        </p>
      ) : (
        <>
          <div className="divide-y divide-gray-100 md:hidden">
            {invoices.map((invoice) => (
              <div key={invoice.id} className="space-y-3 px-4 py-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-gray-900">
                      {invoice.invoice_number ?? `Draft r${invoice.revision}`}
                    </p>
                    <p className="mt-1 truncate text-xs text-gray-500">
                      {invoice.buyer.legal_name} · {invoice.billing_month}
                    </p>
                  </div>
                  <Badge variant={statusVariant(invoice.status)}>{invoice.status}</Badge>
                </div>
                <div className="flex items-end justify-between gap-3">
                  <p className="text-xs text-gray-500">
                    Total <strong className="text-gray-800">{invoice.totals.total.display}</strong>
                    <br />
                    Outstanding{' '}
                    <strong className="text-gray-800">{invoice.totals.outstanding.display}</strong>
                  </p>
                  <Button size="sm" onClick={() => onSelect(invoice.id)}>
                    View
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <DataTable
              headers={['Invoice', 'Organisation', 'Month', 'Status', 'Total', 'Outstanding', '']}
            >
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <Td className="font-medium text-gray-900">
                    {invoice.invoice_number ?? `Draft r${invoice.revision}`}
                  </Td>
                  <Td>{invoice.buyer.legal_name}</Td>
                  <Td>{invoice.billing_month}</Td>
                  <Td>
                    <Badge variant={statusVariant(invoice.status)}>{invoice.status}</Badge>
                  </Td>
                  <Td>{invoice.totals.total.display}</Td>
                  <Td>{invoice.totals.outstanding.display}</Td>
                  <Td className="text-right">
                    <Button size="sm" onClick={() => onSelect(invoice.id)}>
                      View
                    </Button>
                  </Td>
                </tr>
              ))}
            </DataTable>
          </div>
        </>
      )}
      {invoices[0] ? (
        <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-400">
          Latest activity {formatDate(invoices[0].created_at)}
        </p>
      ) : null}
    </Card>
  );
}
