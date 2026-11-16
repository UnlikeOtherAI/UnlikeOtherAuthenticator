import { useMemo } from 'react';
import { Link } from 'react-router';

import { Card } from '../../components/ui/Card';
import { SelectField, TextField } from '../../components/ui/FormFields';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import { SegmentedTabs } from '../../components/ui/Tabs';
import type { BillingService } from '../../schemas/billing';
import { useBillingNavigation } from './billing-navigation';
import { billingOrganisationListRows } from './billing-organisation-tariffs';

type OrganisationLike = { id: string; name: string; slug: string };
type TeamLike = { id: string; orgId: string; name: string; members: number };

/** The Organisations list (§4.1): who has which tariff, by organisation. */
export function BillingOrganisationList({
  organisations,
  products,
  teams,
}: {
  organisations: OrganisationLike[];
  products: BillingService[];
  teams: TeamLike[];
}) {
  const { params, href, update } = useBillingNavigation();
  const query = params.get('q') ?? '';
  const product = products.find((service) => service.id === params.get('product')) ?? null;
  const customOnly = params.get('filter') === 'custom';
  const rows = useMemo(() => billingOrganisationListRows({
    organisations, teams, services: products, productId: product?.id ?? null, query, customOnly,
  }), [customOnly, organisations, product, products, query, teams]);
  const { pageItems, pagination } = usePagination(rows, 10, { key: 'organisations_page' });
  const headers = ['Organisation', 'Teams', product ? 'Tariff' : 'Organisation tariff', 'Team tariffs'];
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 p-4">
        <TextField
          aria-label="Search organisations"
          className="min-w-48 flex-1"
          placeholder="Search organisations"
          value={query}
          onChange={(event) => update({ q: event.target.value, organisations_page: null })}
        />
        <SelectField
          aria-label="Product"
          className="max-w-full"
          value={product?.id ?? ''}
          onChange={(event) => update({ product: event.target.value || null, organisations_page: null })}
        >
          <option value="">All products</option>
          {products.map((service) => (
            <option key={service.id} value={service.id}>{service.name}</option>
          ))}
        </SelectField>
        <div className="[&>div]:mb-0">
          <SegmentedTabs
            value={customOnly ? 'custom' : 'all'}
            onChange={(value) => update({ filter: value === 'custom' ? 'custom' : null, organisations_page: null })}
            options={[
              { label: 'All', value: 'all' },
              { label: 'With custom tariffs', value: 'custom' },
            ]}
          />
        </div>
      </div>
      <DataTable headers={headers}>
        {pageItems.map((row) => (
          <tr key={row.id}>
            <Td>
              <Link
                className="font-medium text-blue-600 hover:underline"
                to={href({ organisation: row.id, organisation_teams_page: null })}
              >
                {row.name}
              </Link>
              <p className="text-xs text-gray-500">{row.slug}</p>
            </Td>
            <Td>{row.teamCount}</Td>
            <Td>
              {row.tariffLines.length ? row.tariffLines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)
                : <span className="text-gray-400">{row.tariffFallback}</span>}
            </Td>
            <Td>
              {row.teamLines.length ? row.teamLines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>) : '—'}
            </Td>
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <Td className="text-gray-400" colSpan={4}>No organisations match.</Td>
          </tr>
        ) : null}
      </DataTable>
      <PaginationFooter {...pagination} />
    </Card>
  );
}
