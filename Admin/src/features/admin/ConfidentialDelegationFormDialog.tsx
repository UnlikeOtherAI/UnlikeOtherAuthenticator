import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import {
  ConfidentialDelegationFormSchema,
  type ConfidentialDelegationFormValues,
  type ConfidentialDelegationMapping,
  type ConfidentialDelegationScope,
} from '../../schemas/confidential-delegation';
import { useDomainsQuery } from './admin-queries';
import {
  useCreateConfidentialDelegationMutation,
  useUpdateConfidentialDelegationMutation,
} from './confidential-delegation-queries';

const scopeOptions: Array<{
  value: ConfidentialDelegationScope;
  label: string;
  description: string;
}> = [
  {
    value: 'ai.invoke',
    label: 'AI invocation',
    description: 'Allows the product to exchange delegated identity for AI calls.',
  },
  {
    value: 'billing.read',
    label: 'Billing read',
    description: 'Allows delegated reads of billing and usage information.',
  },
  {
    value: 'token.provision',
    label: 'Token provisioning',
    description: 'High-trust capability for explicitly approved provisioners only.',
  },
];

const emptyValues: ConfidentialDelegationFormValues = {
  sourceDomain: '',
  product: '',
  resource: '',
  scopes: ['ai.invoke'],
  enabled: true,
};

type Props = {
  mapping: ConfidentialDelegationMapping | null;
  onClose: () => void;
  open: boolean;
};

export function ConfidentialDelegationFormDialog({ mapping, onClose, open }: Props) {
  const { data: domains = [] } = useDomainsQuery();
  const create = useCreateConfidentialDelegationMutation();
  const update = useUpdateConfidentialDelegationMutation();
  const form = useForm<ConfidentialDelegationFormValues>({
    resolver: zodResolver(ConfidentialDelegationFormSchema),
    defaultValues: emptyValues,
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      mapping
        ? {
            sourceDomain: mapping.source_domain,
            product: mapping.product,
            resource: mapping.resource,
            scopes: mapping.scopes,
            enabled: mapping.enabled,
          }
        : emptyValues,
    );
  }, [form, mapping, open]);

  const selectedScopes = form.watch('scopes');
  const enabled = form.watch('enabled');
  const pending = create.isPending || update.isPending;
  const mutationFailed = create.isError || update.isError;

  function toggleScope(scope: ConfidentialDelegationScope) {
    const next = selectedScopes.includes(scope)
      ? selectedScopes.filter((value) => value !== scope)
      : [...selectedScopes, scope];
    form.setValue('scopes', next, { shouldDirty: true, shouldValidate: true });
  }

  async function submit(values: ConfidentialDelegationFormValues) {
    if (mapping) {
      await update.mutateAsync({
        mappingId: mapping.id,
        input: {
          resource: values.resource,
          scopes: values.scopes,
          enabled: values.enabled,
        },
      });
    } else {
      await create.mutateAsync(values);
    }
    onClose();
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={mapping ? 'Edit confidential delegation' : 'Create confidential delegation'}
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            icon="check"
            variant="primary"
            disabled={pending}
            onClick={form.handleSubmit(submit)}
          >
            {pending ? 'Saving...' : mapping ? 'Save changes' : 'Create mapping'}
          </Button>
        </>
      }
    >
      <form className="space-y-5" onSubmit={form.handleSubmit(submit)}>
        {mapping ? (
          <div className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:grid-cols-2">
            <ImmutableValue label="Source domain" value={mapping.source_domain} />
            <ImmutableValue label="Product" value={mapping.product} />
            <p className="sm:col-span-2 text-xs text-gray-500">
              Source domain and product are permanent bindings. Delete and recreate the mapping to
              change either value.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              label="Source domain"
              hint="The registered product domain whose own app credential authenticates the exchange."
              error={form.formState.errors.sourceDomain?.message}
            >
              <SelectField
                {...form.register('sourceDomain')}
                className="w-full font-mono"
                aria-label="Source domain"
              >
                <option value="">Select an active domain</option>
                {domains
                  .filter((domain) => domain.status === 'active')
                  .map((domain) => (
                    <option key={domain.id} value={domain.name}>
                      {domain.name}
                    </option>
                  ))}
              </SelectField>
            </FieldShell>
            <FieldShell
              label="Product"
              hint="Lowercase product identifier carried into the delegated token."
              error={form.formState.errors.product?.message}
            >
              <TextField
                {...form.register('product')}
                className="font-mono"
                placeholder="deepwater"
              />
            </FieldShell>
          </div>
        )}

        <FieldShell
          label="Resource"
          hint="The exact HTTPS audience. Paths, query strings, and trailing slashes are significant."
          error={form.formState.errors.resource?.message}
        >
          <TextField
            {...form.register('resource')}
            className="font-mono"
            placeholder="https://ledger.example.com"
          />
        </FieldShell>

        <fieldset>
          <legend className="text-sm font-medium text-gray-700">Allowed scopes</legend>
          <p className="mt-1 text-xs text-gray-400">
            Requests may only narrow this allowlist; they can never widen it.
          </p>
          <div className="mt-3 space-y-2">
            {scopeOptions.map((scope) => (
              <label
                key={scope.value}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 px-3 py-2.5 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  checked={selectedScopes.includes(scope.value)}
                  onChange={() => toggleScope(scope.value)}
                />
                <span>
                  <span className="block text-sm font-medium text-gray-700">
                    {scope.label} <code className="text-xs text-indigo-700">{scope.value}</code>
                  </span>
                  <span className="mt-0.5 block text-xs text-gray-400">{scope.description}</span>
                </span>
              </label>
            ))}
          </div>
          {form.formState.errors.scopes?.message ? (
            <p className="mt-1 text-xs text-red-600">{form.formState.errors.scopes.message}</p>
          ) : null}
        </fieldset>

        <label className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 p-4">
          <span>
            <span className="block text-sm font-medium text-gray-700">Mapping enabled</span>
            <span className="mt-0.5 block text-xs text-gray-400">
              Disabled mappings fail closed before delegated tokens are issued.
            </span>
          </span>
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            checked={enabled}
            onChange={(event) =>
              form.setValue('enabled', event.target.checked, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          />
        </label>

        {mutationFailed ? (
          <p role="alert" className="text-sm text-red-600">
            The mapping could not be saved. Check that the domain is active and the binding is
            unique, then try again.
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function ImmutableValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <code className="mt-1 block break-all text-sm text-gray-800">{value}</code>
    </div>
  );
}
