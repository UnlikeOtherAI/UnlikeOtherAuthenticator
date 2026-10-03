import { useDirectoryNavigation } from './useDirectoryNavigation';
import { Badge } from '../../components/ui/Badge';
import { Link } from 'react-router';
import { useBillingNavigation } from './billing-navigation';
import { Card, CardHeader } from '../../components/ui/Card';
import { DataTable, Td, PaginationFooter, usePagination } from '../../components/ui/Table';
import type { BillingInvoice } from '../../schemas/billing-contracts';

function statusVariant(status: BillingInvoice['status']) {
  if (status === 'issued') return 'green' as const;
  if (status === 'void') return 'red' as const;
  return 'slate' as const;
}

export function BillingInvoiceHistory({ invoices }: { invoices: BillingInvoice[] }) {
  const { recordState } = useDirectoryNavigation('/billing');
  const { href } = useBillingNavigation();
  const { pageItems, pagination } = usePagination(invoices, 10, { key: 'invoices_page' });
  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Invoice history</h2>
        </div>
      </CardHeader>
      {invoices.length === 0 ? (
        <p className="p-8 text-center text-sm text-gray-500">
          No invoices have been calculated yet.
        </p>
      ) : (
        <>
          <div className="divide-y divide-gray-100 md:hidden">
            {pageItems.map((invoice) => (
              <div key={invoice.id} className="space-y-3 px-4 py-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-gray-900">
                      <Link
                        className="text-blue-600 hover:underline"
                        to={href({ invoice: invoice.id })}
                      >
                        {invoice.invoice_number ?? `Draft r${invoice.revision}`}
                      </Link>
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
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <DataTable
              headers={['Invoice', 'Organisation', 'Month', 'Status', 'Total', 'Outstanding']}
            >
              {pageItems.map((invoice) => (
                <tr key={invoice.id}>
                  <Td className="font-medium text-gray-900">
                    <Link
                      className="text-blue-600 hover:underline"
                      to={href({ invoice: invoice.id })}
                    >
                      {invoice.invoice_number ?? `Draft r${invoice.revision}`}
                    </Link>
                  </Td>
                  <Td>
                    <Link
                      className="text-blue-600 hover:underline"
                      state={recordState}
                      to={`/organisations/${encodeURIComponent(invoice.organisation_id)}`}
                    >
                      {invoice.buyer.legal_name}
                    </Link>
                  </Td>
                  <Td>{invoice.billing_month}</Td>
                  <Td>
                    <Badge variant={statusVariant(invoice.status)}>{invoice.status}</Badge>
                  </Td>
                  <Td>{invoice.totals.total.display}</Td>
                  <Td>{invoice.totals.outstanding.display}</Td>
                </tr>
              ))}
            </DataTable>
          </div>
        </>
      )}
      <PaginationFooter {...pagination} />
    </Card>
  );
}
