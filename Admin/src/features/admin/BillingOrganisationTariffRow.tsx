import { Link } from 'react-router';

import { Button } from '../../components/ui/Button';
import { SelectField } from '../../components/ui/FormFields';
import { Td } from '../../components/ui/Table';
import type { BillingTariff } from '../../schemas/billing';
import { billingActor, billingDate, billingDateTime, billingTariffSummary } from './billing-format';
import { billingAssignmentStartNote, type BillingTariffRowModel } from './billing-organisation-tariffs';

/** One "Applies to" row of the organisation's tariff table (§4.2). */
export function BillingOrganisationTariffRow({
  disabled,
  error,
  linkState,
  onCancel,
  onChange,
  onSave,
  organisationId,
  pending,
  row,
  tariffs,
  value,
}: {
  disabled: boolean;
  error: string | null;
  linkState: unknown;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
  organisationId: string;
  pending: boolean;
  row: BillingTariffRowModel;
  tariffs: BillingTariff[];
  value: string;
}) {
  const selected = value ? tariffs.find((tariff) => tariff.id === value) ?? null : row.fallback;
  const startNote = billingAssignmentStartNote(row.assignment);
  const changed = value !== row.savedValue;
  return (
    <tr>
      <Td className="min-w-44">
        {row.teamId === null ? (
          <>
            <p className="font-medium text-gray-800">Entire organisation</p>
            <p className="text-xs text-gray-500">Every team without its own tariff</p>
          </>
        ) : (
          <>
            <Link
              className="font-medium text-blue-600 hover:underline"
              state={linkState}
              to={`/organisations/${organisationId}/teams/${row.teamId}`}
            >
              {row.name}
            </Link>
            <p className="text-xs text-gray-500">
              {row.members} member{row.members === 1 ? '' : 's'}
            </p>
          </>
        )}
      </Td>
      <Td>
        <SelectField
          aria-label={row.teamId === null ? 'Tariff for the entire organisation' : `Tariff for ${row.name}`}
          className="w-full min-w-64"
          disabled={disabled || pending}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {row.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </SelectField>
        {startNote && !changed ? <p className="mt-1 text-xs text-amber-600">{startNote}</p> : null}
        {error ? <p className="mt-1 text-xs text-red-600" role="alert">{error}</p> : null}
      </Td>
      <Td className="min-w-56">{selected ? billingTariffSummary(selected) : '—'}</Td>
      <Td className="hidden whitespace-nowrap md:table-cell">
        {row.assignment ? (
          <>
            <span title={billingDateTime(row.assignment.updated_at)}>
              {billingDate(row.assignment.updated_at)}
            </span>
            <span className="block text-xs text-gray-500">
              {billingActor(row.assignment.created_by_email)}
            </span>
          </>
        ) : '—'}
      </Td>
      <Td className="w-48 min-w-48 whitespace-nowrap">
        {changed ? (
          <div className="flex gap-2">
            <Button disabled={pending} size="sm" variant="primary" onClick={onSave}>
              {pending ? 'Saving...' : 'Save'}
            </Button>
            <Button disabled={pending} size="sm" onClick={onCancel}>Cancel</Button>
          </div>
        ) : null}
      </Td>
    </tr>
  );
}
