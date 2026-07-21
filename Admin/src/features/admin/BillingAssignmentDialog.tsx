import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';

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
  const eligibleTeams = useMemo(
    () => teams.filter((team) => team.orgId === organisationId),
    [organisationId, teams],
  );

  useEffect(() => {
    if (open) {
      form.reset({
        ...defaults,
        tariffId: service.tariffs.find((tariff) => tariff.is_default)?.id ?? '',
      });
    }
  }, [form, open, service.tariffs]);

  useEffect(() => {
    const selectedTeam = form.getValues('teamId');
    if (selectedTeam && !eligibleTeams.some((team) => team.id === selectedTeam)) {
      form.setValue('teamId', '');
    }
  }, [eligibleTeams, form]);

  async function submit(values: BillingAssignmentFormValues) {
    await save.mutateAsync(values);
    onClose();
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Assign tariff · ${service.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
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
            {service.tariffs.map((tariff) => (
              <option key={tariff.id} value={tariff.id}>
                {tariff.name} · {tariff.key} v{tariff.version}
                {tariff.is_default ? ' · default' : ''}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Team assignments override organisation assignments, which override the service default.
          Active Stripe subscriptions pin their assignment until they terminate.
        </div>
        {save.isError ? (
          <p className="text-sm text-red-600">
            {save.error instanceof Error ? save.error.message : 'Could not save assignment.'}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
