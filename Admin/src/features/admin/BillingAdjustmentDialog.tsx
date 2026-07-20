import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import {
  BillingAdjustmentFormSchema,
  type BillingAdjustmentFormValues,
  type BillingService,
} from '../../schemas/billing';
import { useOrganisationsQuery, useTeamsQuery } from './admin-queries';
import { useCreateBillingAdjustmentMutation } from './billing-admin-queries';

function monthStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

const defaults: BillingAdjustmentFormValues = {
  organisationId: '',
  teamId: '',
  key: '',
  name: '',
  kind: 'add_on',
  cadence: 'monthly',
  amountMinor: '0',
  currency: 'GBP',
  startsAt: monthStart(),
  endsAt: '',
};

export function BillingAdjustmentDialog({
  onClose,
  open,
  service,
}: {
  onClose: () => void;
  open: boolean;
  service: BillingService;
}) {
  const { data: organisations = [] } = useOrganisationsQuery();
  const { data: teams = [] } = useTeamsQuery();
  const create = useCreateBillingAdjustmentMutation(service.id);
  const form = useForm<BillingAdjustmentFormValues>({
    resolver: zodResolver(BillingAdjustmentFormSchema),
    defaultValues: defaults,
  });
  const organisationId = form.watch('organisationId');
  const eligibleTeams = useMemo(
    () => teams.filter((team) => team.orgId === organisationId),
    [organisationId, teams],
  );

  useEffect(() => {
    if (open) form.reset({ ...defaults, startsAt: monthStart() });
  }, [form, open]);

  useEffect(() => {
    const selectedTeam = form.getValues('teamId');
    if (selectedTeam && !eligibleTeams.some((team) => team.id === selectedTeam)) {
      form.setValue('teamId', '');
    }
  }, [eligibleTeams, form]);

  async function submit(values: BillingAdjustmentFormValues) {
    await create.mutateAsync(values);
    onClose();
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Add commercial line · ${service.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            icon="check"
            variant="primary"
            disabled={create.isPending}
            onClick={form.handleSubmit(submit)}
          >
            {create.isPending ? 'Saving...' : 'Add line'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="Organisation" error={form.formState.errors.organisationId?.message}>
          <SelectField {...form.register('organisationId')} className="w-full">
            <option value="">Select organisation</option>
            {organisations.map((organisation) => (
              <option key={organisation.id} value={organisation.id}>
                {organisation.name}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell
          label="Team (optional)"
          hint="Leave empty to include the line for every team in the organisation."
        >
          <SelectField {...form.register('teamId')} className="w-full">
            <option value="">Entire organisation</option>
            {eligibleTeams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell label="Line key" error={form.formState.errors.key?.message}>
            <TextField {...form.register('key')} placeholder="priority-support" />
          </FieldShell>
          <FieldShell label="Display name" error={form.formState.errors.name?.message}>
            <TextField {...form.register('name')} placeholder="Priority support" />
          </FieldShell>
          <FieldShell label="Kind">
            <SelectField {...form.register('kind')}>
              <option value="add_on">Add-on</option>
              <option value="credit">Credit</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Cadence">
            <SelectField {...form.register('cadence')}>
              <option value="monthly">Monthly</option>
              <option value="one_time">One-time</option>
            </SelectField>
          </FieldShell>
          <FieldShell
            label="Amount (minor units)"
            error={form.formState.errors.amountMinor?.message}
          >
            <TextField {...form.register('amountMinor')} inputMode="numeric" placeholder="2000" />
          </FieldShell>
          <FieldShell label="Currency" error={form.formState.errors.currency?.message}>
            <TextField {...form.register('currency')} maxLength={3} />
          </FieldShell>
          <FieldShell label="Starts" error={form.formState.errors.startsAt?.message}>
            <TextField {...form.register('startsAt')} type="date" />
          </FieldShell>
          <FieldShell label="Ends (optional)" error={form.formState.errors.endsAt?.message}>
            <TextField {...form.register('endsAt')} type="date" />
          </FieldShell>
        </div>
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          UOA adds this exact line to the canonical customer statement. Ledger never receives or
          supplies this commercial value.
        </div>
        {create.isError ? (
          <p className="text-sm text-red-600">
            {create.error instanceof Error
              ? create.error.message
              : 'Could not create the commercial line.'}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
