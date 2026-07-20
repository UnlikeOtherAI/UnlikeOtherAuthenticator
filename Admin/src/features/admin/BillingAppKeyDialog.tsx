import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextAreaField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import {
  BillingAppKeyFormSchema,
  type BillingAppKeyFormValues,
  type BillingService,
  type CreatedBillingAppKey,
} from '../../schemas/billing';
import { useCreateBillingAppKeyMutation } from './billing-admin-queries';

function defaults(): BillingAppKeyFormValues {
  return {
    purpose: 'customer_lifecycle',
    name: '',
    actorIssuer: '',
    actorAudience: `${window.location.origin}/billing/v1/effective-tariff`,
    actorPublicJwkJson: '',
    checkoutReturnOrigins: '',
    expiresAt: '',
  };
}

export function BillingAppKeyDialog({
  onClose,
  onCreated,
  open,
  service,
}: {
  onClose: () => void;
  onCreated: (key: CreatedBillingAppKey) => void;
  open: boolean;
  service: BillingService;
}) {
  const create = useCreateBillingAppKeyMutation(service.id);
  const form = useForm<BillingAppKeyFormValues>({
    resolver: zodResolver(BillingAppKeyFormSchema),
    defaultValues: defaults(),
  });
  const purpose = form.watch('purpose');

  useEffect(() => {
    if (open) form.reset(defaults());
  }, [form, open]);

  useEffect(() => {
    if (purpose === 'entitlement') {
      form.setValue('checkoutReturnOrigins', '');
    }
  }, [form, purpose]);

  async function submit(values: BillingAppKeyFormValues) {
    const created = await create.mutateAsync(values);
    onCreated(created);
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Issue product app key · ${service.name}`}
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            icon="key"
            variant="primary"
            disabled={create.isPending}
            onClick={form.handleSubmit(submit)}
          >
            {create.isPending ? 'Issuing...' : 'Issue app key'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell
          label="Purpose"
          hint="Entitlement keys can only read signed tariffs; lifecycle keys can only manage Checkout and subscriptions."
          error={form.formState.errors.purpose?.message}
        >
          <SelectField {...form.register('purpose')} className="w-full">
            <option value="customer_lifecycle">Customer lifecycle</option>
            <option value="entitlement">Entitlement resolver</option>
          </SelectField>
        </FieldShell>
        <FieldShell
          label="Key name"
          hint="Name the deployment that will own this key."
          error={form.formState.errors.name?.message}
        >
          <TextField {...form.register('name')} placeholder="DeepWater production" />
        </FieldShell>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            label="Actor issuer"
            hint="Exact HTTPS origin of the product signing X-UOA-Actor."
            error={form.formState.errors.actorIssuer?.message}
          >
            <TextField
              {...form.register('actorIssuer')}
              className="font-mono"
              placeholder="https://api.deepwater.example"
            />
          </FieldShell>
          <FieldShell
            label="Actor audience"
            hint="Pinned to this UOA effective-tariff endpoint."
            error={form.formState.errors.actorAudience?.message}
          >
            <TextField {...form.register('actorAudience')} className="font-mono" readOnly />
          </FieldShell>
        </div>
        <FieldShell
          label="Actor public JWK"
          hint="Public-only RSA RS256 JWK with a stable kid. Never paste a private key."
          error={form.formState.errors.actorPublicJwkJson?.message}
        >
          <TextAreaField
            {...form.register('actorPublicJwkJson')}
            className="min-h-32 font-mono text-xs"
            placeholder='{"kty":"RSA","kid":"billing-2026-01","alg":"RS256","use":"sig","n":"...","e":"AQAB"}'
          />
        </FieldShell>
        {purpose === 'customer_lifecycle' ? (
          <FieldShell
            label="Checkout return origins"
            hint="Required HTTPS origins, one per line. Paths are added by the product at request time."
            error={form.formState.errors.checkoutReturnOrigins?.message}
          >
            <TextAreaField
              {...form.register('checkoutReturnOrigins')}
              className="min-h-20 font-mono text-xs"
              placeholder="https://app.nessie.works"
            />
          </FieldShell>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
            Entitlement keys cannot carry redirect origins and are rejected by every Stripe
            lifecycle route.
          </div>
        )}
        <FieldShell
          label="Expiry (optional)"
          hint="Leave blank for no automatic expiry; revocation is always available."
          error={form.formState.errors.expiresAt?.message}
        >
          <TextField {...form.register('expiresAt')} type="date" />
        </FieldShell>
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          This {purpose.replace('_', ' ')} key authenticates only {service.identifier}. Every
          request still needs a fresh, signed actor assertion binding the user, organisation, team,
          and product.
        </div>
        {create.isError ? (
          <p className="text-sm text-red-600">
            {create.error instanceof Error ? create.error.message : 'Could not issue app key.'}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
