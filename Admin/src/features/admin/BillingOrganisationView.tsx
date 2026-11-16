import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { Card, CardHeader } from '../../components/ui/Card';
import { DataTable, PaginationFooter, usePagination } from '../../components/ui/Table';
import { UnderlineTabs } from '../../components/ui/Tabs';
import type { BillingService } from '../../schemas/billing';
import { useAdminUi } from '../shell/admin-ui';
import { useRemoveBillingAssignmentMutation, useSaveBillingAssignmentMutation } from './billing-admin-queries';
import { billingTariffName } from './billing-format';
import { useBillingNavigation } from './billing-navigation';
import {
  billingDefaultTariff,
  billingOrganisationAssignmentCount,
  billingOrganisationTariffRows,
  billingTariffChange,
  billingTariffRefusal,
  type BillingTariffRowModel,
} from './billing-organisation-tariffs';
import { BillingOrganisationTariffRow } from './BillingOrganisationTariffRow';
import { OrganisationBillingModePanel } from './OrganisationBillingModePanel';
import { useDirectoryNavigation } from './useDirectoryNavigation';

type OrganisationLike = { id: string; name: string; slug: string };
type TeamLike = { id: string; orgId: string; name: string; members: number };

/** One organisation (§4.2): per product, the tariff of the organisation and of each of its teams. */
export function BillingOrganisationView({
  organisation,
  products,
  teams,
}: {
  organisation: OrganisationLike;
  products: BillingService[];
  teams: TeamLike[];
}) {
  const { params, update } = useBillingNavigation();
  const { recordState } = useDirectoryNavigation('/billing');
  const product = products.find((service) => service.id === params.get('product')) ?? products[0] ?? null;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">{organisation.name}</h2>
            <code className="rounded-sm bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{organisation.slug}</code>
          </div>
          <Link
            className="text-sm text-blue-600 hover:underline"
            state={recordState}
            to={`/organisations/${organisation.id}`}
          >
            Organisation details
          </Link>
        </CardHeader>
        {product ? (
          <>
            <div className="px-5 pt-4">
              <UnderlineTabs
                value={product.id}
                onChange={(value) => update({ product: value, organisation_teams_page: null })}
                options={products.map((service) => ({
                  label: service.name,
                  value: service.id,
                  count: billingOrganisationAssignmentCount(service, organisation.id),
                }))}
              />
            </div>
            <OrganisationProductTariffs
              key={product.id}
              linkState={recordState}
              organisation={organisation}
              service={product}
              teams={teams}
            />
          </>
        ) : (
          <p className="px-5 py-8 text-sm text-gray-400">No products yet.</p>
        )}
      </Card>
      <OrganisationBillingModePanel key={organisation.id} organisationId={organisation.id} />
    </div>
  );
}

function OrganisationProductTariffs({
  linkState,
  organisation,
  service,
  teams,
}: {
  linkState: unknown;
  organisation: OrganisationLike;
  service: BillingService;
  teams: TeamLike[];
}) {
  const { confirm } = useAdminUi();
  const save = useSaveBillingAssignmentMutation(service.id);
  const remove = useRemoveBillingAssignmentMutation(service.id);
  const { organisationRow, teamRows } = useMemo(
    () => billingOrganisationTariffRows(service, organisation, teams),
    [organisation, service, teams],
  );
  const { pageItems, pagination } = usePagination(teamRows, 10, { key: 'organisation_teams_page' });
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const productDefault = billingDefaultTariff(service);

  function clearError(key: string) {
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key)));
  }

  function change(row: BillingTariffRowModel, value: string) {
    clearError(row.key);
    setDraft(value === row.savedValue ? null : { key: row.key, value });
  }

  function requestSave(row: BillingTariffRowModel) {
    if (draft?.key !== row.key) return;
    const pendingChange = billingTariffChange(service, row, draft.value);
    if (!pendingChange) return;
    confirm(pendingChange.title, pendingChange.body, async () => {
      setPendingKey(row.key);
      clearError(row.key);
      try {
        if (pendingChange.kind === 'save') {
          await save.mutateAsync({
            organisationId: organisation.id,
            teamId: row.teamId ?? '',
            tariffId: pendingChange.tariffId,
          });
        } else {
          await remove.mutateAsync(pendingChange.assignmentId);
        }
        setDraft(null);
      } catch (error) {
        // The selection stays so the operator can see what was refused and retry or cancel.
        setErrors((current) => ({ ...current, [row.key]: billingTariffRefusal(error) }));
      } finally {
        setPendingKey(null);
      }
    });
  }

  function renderRow(row: BillingTariffRowModel) {
    return (
      <BillingOrganisationTariffRow
        key={row.key}
        disabled={pendingKey !== null || (draft !== null && draft.key !== row.key)}
        error={errors[row.key] ?? null}
        linkState={linkState}
        organisationId={organisation.id}
        pending={pendingKey === row.key}
        row={row}
        tariffs={service.tariffs}
        value={draft?.key === row.key ? draft.value : row.savedValue}
        onCancel={() => {
          clearError(row.key);
          setDraft(null);
        }}
        onChange={(value) => change(row, value)}
        onSave={() => requestSave(row)}
      />
    );
  }

  return (
    <>
      <p className="px-5 pb-4 text-xs text-gray-500">
        Product default: {productDefault ? billingTariffName(productDefault) : '—'}. A team&apos;s tariff
        overrides its organisation&apos;s, which overrides the product default. A change starts on the
        1st of next month (UTC).
      </p>
      <DataTable headers={['Applies to', 'Tariff', 'What they pay', 'Changed', '']}>
        {renderRow(organisationRow)}
        {pageItems.map(renderRow)}
      </DataTable>
      <PaginationFooter {...pagination} />
    </>
  );
}
