import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';

import { AutocompleteSelect } from '../../components/ui/AutocompleteSelect';
import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import {
  BillingAssignmentFormSchema,
  type BillingAssignmentFormValues,
  type BillingService,
} from '../../schemas/billing';
import { useOrganisationsQuery, useTeamsQuery } from './admin-queries';
import { useSaveBillingAssignmentMutation } from './billing-admin-queries';
import { billingRefusal, billingTariffLabel } from './billing-format';

const defaults: BillingAssignmentFormValues = {
  organisationId: '',
  teamId: '',
  tariffId: '',
};

export function BillingAssignmentDialog({
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
  const save = useSaveBillingAssignmentMutation(service.id);
  const form = useForm<BillingAssignmentFormValues>({
    resolver: zodResolver(BillingAssignmentFormSchema),
    defaultValues: defaults,
  });
  const organisationId = form.watch('organisationId');
  // A retired version can never be given to anybody, so it is never offered.
  const activeTariffs = useMemo(
    () => service.tariffs.filter((tariff) => !tariff.retired_at),
    [service.tariffs],
  );
  const organisationOptions = useMemo(
    () => organisations.map((organisation) => ({ label: organisation.name, value: organisation.id })),
    [organisations],
  );
  const eligibleTeams = useMemo(
    () => teams.filter((team) => team.orgId === organisationId),
    [organisationId, teams],
  );

  useEffect(() => {
    if (open) {
      form.reset({
        ...defaults,
        tariffId: activeTariffs.find((tariff) => tariff.is_default)?.id ?? '',
      });
    }
  }, [form, open, activeTariffs]);

  useEffect(() => {
    const selectedTeam = form.getValues('teamId');
    if (selectedTeam && !eligibleTeams.some((team) => team.id === selectedTeam)) {
      form.setValue('teamId', '');
    }
  }, [eligibleTeams, form]);

  async function submit(values: BillingAssignmentFormValues) {
    try {
      await save.mutateAsync(values);
      onClose();
    } catch {
      /* Keep values and show the mutation error for retry. */
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      isPending={save.isPending}
      isDirty={form.formState.isDirty}
      title={`Assign tariff · ${service.name}`}
      footer={
        <>
          <Button
            icon="check"
            variant="primary"
            disabled={save.isPending}
            onClick={form.handleSubmit(submit)}
          >
            {save.isPending ? 'Saving...' : 'Save assignment'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <div>
          <AutocompleteSelect
            label="Organisation"
            placeholder="Search organisations"
            allLabel="Select organisation"
            options={organisationOptions}
            value={organisationId}
            onChange={(value) =>
              form.setValue('organisationId', value === 'all' ? '' : value, {
                shouldDirty: true,
                shouldValidate: form.formState.isSubmitted,
              })}
          />
          {form.formState.errors.organisationId?.message ? (
            <p className="mt-1.5 text-xs text-red-600">
              {form.formState.errors.organisationId.message}
            </p>
          ) : null}
        </div>
        <FieldShell
          label="Team (optional)"
          hint="Leave empty to apply the tariff to the whole organisation."
        >
          <SelectField {...form.register('teamId')} className="w-full">
            <option value="">Entire organisation</option>
            {eligibleTeams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} · {team.orgName} · {team.members} member{team.members === 1 ? '' : 's'}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Tariff version" error={form.formState.errors.tariffId?.message}>
          <SelectField {...form.register('tariffId')} className="w-full">
            <option value="">Select tariff</option>
            {activeTariffs.map((tariff) => (
              <option key={tariff.id} value={tariff.id}>
                {billingTariffLabel(tariff, service.tariffs)}
                {tariff.is_default ? ' · default' : ''}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Team assignments override organisation assignments, which override the product default.
          Active Stripe subscriptions pin their assignment until they terminate.
        </div>
        {save.isError ? (
          <p className="text-sm text-red-600">
            {billingRefusal(save.error)}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
