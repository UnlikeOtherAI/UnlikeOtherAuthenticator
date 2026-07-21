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
  type BillingCreditAdjustmentPreview,
} from '../../schemas/billing-credits';
import {
  useCreateBillingCreditAdjustmentMutation,
  usePreviewBillingCreditAdjustmentMutation,
} from './billing-admin-queries';
import { CopyableIdentifier } from './CopyableIdentifier';

function newIdempotencyKey(): string {
  return `credit-adjustment:${globalThis.crypto.randomUUID()}`;
}

function valuesKey(values: BillingCreditAdjustmentFormValues): string {
  return JSON.stringify([
    values.signedCredits.trim(),
    values.reason.trim(),
    values.idempotencyKey.trim(),
  ]);
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
  const previewMutation = usePreviewBillingCreditAdjustmentMutation(account);
  const createMutation = useCreateBillingCreditAdjustmentMutation(account.id);
  const [reviewed, setReviewed] = useState<{
    key: string;
    preview: BillingCreditAdjustmentPreview;
  } | null>(null);
  const [confirmedToken, setConfirmedToken] = useState<string | null>(null);
  const form = useForm<BillingCreditAdjustmentFormValues>({
    resolver: zodResolver(BillingCreditAdjustmentFormSchema),
    defaultValues: { signedCredits: '', reason: '', idempotencyKey: newIdempotencyKey() },
  });
  const watched = form.watch();
  const currentValuesKey = valuesKey(watched);
  const preview = reviewed?.key === currentValuesKey ? reviewed.preview : null;
  const liveConfirmed = Boolean(preview && confirmedToken === preview.confirmation_token);
  const resetPreview = previewMutation.reset;
  const resetCreate = createMutation.reset;

  useEffect(() => {
    if (!open) return;
    resetPreview();
    resetCreate();
    setReviewed(null);
    setConfirmedToken(null);
    form.reset({ signedCredits: '', reason: '', idempotencyKey: newIdempotencyKey() });
  }, [account.id, form, open, resetCreate, resetPreview]);

  async function review(values: BillingCreditAdjustmentFormValues): Promise<void> {
    try {
      const result = await previewMutation.mutateAsync(values);
      setReviewed({ key: valuesKey(values), preview: result });
      setConfirmedToken(null);
    } catch {
      setReviewed(null);
      setConfirmedToken(null);
    }
  }

  async function post(): Promise<void> {
    if (!preview) return;
    try {
      await createMutation.mutateAsync(preview.confirmation_token);
      onClose();
    } catch {
      // Keep the exact short-lived server token for a safe idempotent retry.
    }
  }

  function submit(values: BillingCreditAdjustmentFormValues): Promise<void> {
    return preview ? post() : review(values);
  }

  const busy = previewMutation.isPending || createMutation.isPending;
  const error = previewMutation.error ?? createMutation.error;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Adjust team credits"
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            icon="check"
            variant="primary"
            disabled={busy || Boolean(preview && account.mode === 'live' && !liveConfirmed)}
            onClick={form.handleSubmit(submit)}
          >
            {previewMutation.isPending
              ? 'Preparing review...'
              : createMutation.isPending
                ? 'Posting...'
                : preview
                  ? 'Post reviewed adjustment'
                  : 'Review adjustment'}
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
          <div className="mt-3 space-y-1">
            <CopyableIdentifier label="Account" value={account.id} />
            <CopyableIdentifier label="Organisation" value={account.organisation.id} />
            <CopyableIdentifier label="Team" value={account.team.id} />
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
          1,000 credits = US$1.00. The server will freeze the exact current and resulting balance in
          a short-lived confirmation before anything is posted.
        </div>

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
          hint="Use the generated key or supply your own; it is retained for an exact retry."
          error={form.formState.errors.idempotencyKey?.message}
        >
          <TextField
            {...form.register('idempotencyKey')}
            aria-label="Request reference"
            className="font-mono text-xs"
          />
        </FieldShell>

        {reviewed && !preview ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The values changed after review. Prepare a fresh server confirmation before posting.
          </p>
        ) : null}

        {preview ? (
          <div className="space-y-3 rounded-xl border-2 border-indigo-300 bg-indigo-50 p-4">
            <div>
              <p className="text-sm font-semibold text-indigo-950">Server-confirmed adjustment</p>
              <p className="mt-0.5 text-xs text-indigo-800">
                Valid until {new Date(preview.expires_at).toLocaleTimeString()}.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-indigo-700">Current</p>
                <p className="font-semibold text-indigo-950">{preview.current_credits.display}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-indigo-700">Change</p>
                <p className="font-semibold text-indigo-950">{preview.signed_credits.display}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-indigo-700">Resulting</p>
                <p className="font-semibold text-indigo-950">{preview.resulting_credits.display}</p>
              </div>
            </div>
            <div className="rounded-lg border border-indigo-200 bg-white p-3 text-xs text-gray-700">
              <p className="font-semibold text-gray-900">
                Automatic top-up: {preview.automatic_top_up.state.replaceAll('_', ' ')}
              </p>
              <p className="mt-1">{preview.automatic_top_up.consequence.message}</p>
              <p className="mt-2 text-gray-500">
                Threshold: {preview.automatic_top_up.threshold_credits?.display ?? 'Not set'} ·
                Refill: {preview.automatic_top_up.refill_credits?.display ?? 'Not set'} ·
                Generation: {preview.automatic_top_up.generation}
              </p>
            </div>
          </div>
        ) : null}

        {preview && account.mode === 'live' ? (
          <div className="rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 text-red-900">
            <p className="text-sm font-semibold">Live customer balance</p>
            <p className="mt-1 text-xs">
              Posting applies the exact server-confirmed values above to {account.team.name}.
            </p>
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium">
              <input
                aria-label={`Confirm live adjustment for ${account.team.name}`}
                checked={liveConfirmed}
                className="mt-0.5 h-4 w-4 accent-red-600"
                type="checkbox"
                onChange={(event) =>
                  setConfirmedToken(event.target.checked ? preview.confirmation_token : null)
                }
              />
              <span>I confirm this exact live balance adjustment for {account.team.name}.</span>
            </label>
          </div>
        ) : null}

        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error instanceof Error
              ? error.message
              : 'Could not complete the credit adjustment. Review the current account state and try again.'}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
