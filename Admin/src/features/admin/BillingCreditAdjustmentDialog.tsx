import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { FieldShell, TextAreaField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import {
  BillingCreditAdjustmentFormSchema,
  type BillingCreditAccount,
  type BillingCreditAdjustmentFormValues,
} from '../../schemas/billing-credits';
import { useCreateBillingCreditAdjustmentMutation } from './billing-admin-queries';

function newIdempotencyKey(): string {
  return `credit-adjustment:${globalThis.crypto.randomUUID()}`;
}

export function BillingCreditAdjustmentDialog({
  account,
  onClose,
  open,
}: {
  account: BillingCreditAccount;
  onClose: () => void;
  open: boolean;
}) {
  const create = useCreateBillingCreditAdjustmentMutation(account);
  const [initialIdempotencyKey] = useState(newIdempotencyKey);
  const [confirmedLiveValues, setConfirmedLiveValues] = useState<string | null>(null);
  const form = useForm<BillingCreditAdjustmentFormValues>({
    resolver: zodResolver(BillingCreditAdjustmentFormSchema),
    defaultValues: { signedCredits: '', reason: '', idempotencyKey: initialIdempotencyKey },
  });
  const resetMutation = create.reset;
  const watchedValues = form.watch(['signedCredits', 'reason', 'idempotencyKey']);
  const liveValuesKey = JSON.stringify(watchedValues);
  const liveConfirmationReady = watchedValues.every((value) => value.trim().length > 0);
  const liveConfirmed = liveConfirmationReady && confirmedLiveValues === liveValuesKey;

  useEffect(() => {
    if (!open) return;
    resetMutation();
    setConfirmedLiveValues(null);
    form.reset({ signedCredits: '', reason: '', idempotencyKey: newIdempotencyKey() });
  }, [account.id, form, open, resetMutation]);

  async function submit(values: BillingCreditAdjustmentFormValues) {
    try {
      await create.mutateAsync(values);
      onClose();
    } catch {
      // React Query retains the failure and the form's idempotency key for an exact retry.
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Adjust team credits"
      widthClassName="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            icon="check"
            variant="primary"
            disabled={create.isPending || (account.mode === 'live' && !liveConfirmed)}
            onClick={form.handleSubmit(submit)}
          >
            {create.isPending ? 'Posting...' : 'Post adjustment'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">{account.team.name}</p>
              <p className="mt-0.5 text-xs text-gray-500">{account.organisation.name}</p>
            </div>
            <Badge variant={account.mode === 'live' ? 'green' : 'amber'}>
              {account.mode === 'live' ? 'Live' : 'Test'}
            </Badge>
          </div>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-semibold text-gray-900">
              {account.remaining_credits.display}
            </span>
            <span className="text-xs text-gray-500">
              {account.remaining_credits.usd_equivalent.display} equivalent
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          1,000 credits = US$1.00. Positive amounts add credits; negative amounts remove credits.
          The resulting entry is permanent and auditable.
        </div>

        {account.mode === 'live' ? (
          <div className="rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 text-red-900">
            <p className="text-sm font-semibold">Live customer balance</p>
            <p className="mt-1 text-xs">
              Posting immediately changes the live credits available to {account.team.name}. Check
              the exact organisation, team, signed amount, and reason before continuing.
            </p>
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium">
              <input
                aria-label={`Confirm live adjustment for ${account.team.name}`}
                checked={liveConfirmed}
                className="mt-0.5 h-4 w-4 accent-red-600"
                disabled={!liveConfirmationReady}
                type="checkbox"
                onChange={(event) =>
                  setConfirmedLiveValues(event.target.checked ? liveValuesKey : null)
                }
              />
              <span>I confirm this live balance adjustment for {account.team.name}.</span>
            </label>
          </div>
        ) : null}

        <FieldShell
          label="Signed credit amount"
          hint="For example, 50000 adds 50,000 credits and -2500 removes 2,500."
          error={form.formState.errors.signedCredits?.message}
        >
          <TextField
            {...form.register('signedCredits')}
            aria-label="Signed credit amount"
            autoComplete="off"
            inputMode="decimal"
            placeholder="50000"
          />
        </FieldShell>

        <FieldShell
          label="Reason"
          hint="Required for the immutable operator audit trail."
          error={form.formState.errors.reason?.message}
        >
          <TextAreaField
            {...form.register('reason')}
            aria-label="Reason"
            className="min-h-24 resize-y"
            maxLength={1000}
            placeholder="Why this team's credit balance is changing"
          />
        </FieldShell>

        <FieldShell
          label="Request reference"
          hint="Use the generated key or supply your own; it is retained if the request is retried."
          error={form.formState.errors.idempotencyKey?.message}
        >
          <TextField
            {...form.register('idempotencyKey')}
            aria-label="Request reference"
            className="font-mono text-xs"
          />
        </FieldShell>

        {create.isError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {create.error instanceof Error
              ? create.error.message
              : 'Could not post the credit adjustment. You can retry with the same request reference.'}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
