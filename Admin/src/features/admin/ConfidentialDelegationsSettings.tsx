import { useState } from 'react';

import { ActionButton, ActionDivider } from '../../components/ui/ActionButton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import type { ConfidentialDelegationMapping } from '../../schemas/confidential-delegation';
import { useAdminUi } from '../shell/admin-ui';
import { ConfidentialDelegationFormDialog } from './ConfidentialDelegationFormDialog';
import {
  useConfidentialDelegationsQuery,
  useDeleteConfidentialDelegationMutation,
  useUpdateConfidentialDelegationMutation,
} from './confidential-delegation-queries';

export function ConfidentialDelegationsSettings() {
  const { confirm } = useAdminUi();
  const { data: mappings = [], isError, isLoading } = useConfidentialDelegationsQuery();
  const update = useUpdateConfidentialDelegationMutation();
  const remove = useDeleteConfidentialDelegationMutation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConfidentialDelegationMapping | null>(null);
  const { pageItems, pagination } = usePagination(mappings);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(mapping: ConfidentialDelegationMapping) {
    setEditing(mapping);
    setDialogOpen(true);
  }

  function deleteMapping(mapping: ConfidentialDelegationMapping) {
    confirm(
      `Delete ${mapping.product} delegation?`,
      `This immediately blocks ${mapping.source_domain} from exchanging delegated identity for ${mapping.resource}. This cannot be undone.`,
      () => remove.mutateAsync(mapping.id),
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <p className="font-semibold">
          Application identity and delegated user identity stay separate.
        </p>
        <p className="mt-1 text-xs text-blue-800">
          Each mapping authorises one registered source product, using that product&apos;s own app
          credential, to request a narrow resource-bound token. No browser credential or product
          secret is displayed here.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div>
            <span className="text-sm font-semibold text-gray-900">
              Confidential delegation mappings
            </span>
            <p className="mt-0.5 text-xs text-gray-400">
              Exact source, product, resource, and scope policy for server-to-server token exchange.
            </p>
          </div>
          <Button icon="plus" size="sm" variant="primary" onClick={openCreate}>
            Create mapping
          </Button>
        </CardHeader>

        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading delegation mappings...</p>
        ) : isError ? (
          <p role="alert" className="px-5 py-6 text-sm text-red-600">
            Delegation mappings could not be loaded.
          </p>
        ) : (
          <>
            <DataTable
              headers={['Source product', 'Resource', 'Scopes', 'Status', 'Updated', 'Actions']}
            >
              {pageItems.map((mapping) => (
                <tr key={mapping.id}>
                  <Td>
                    <p className="font-medium text-gray-800">{mapping.product}</p>
                    <code className="text-xs text-gray-400">{mapping.source_domain}</code>
                  </Td>
                  <Td>
                    <code className="block max-w-xs break-all text-xs text-gray-600">
                      {mapping.resource}
                    </code>
                  </Td>
                  <Td>
                    <div className="flex max-w-xs flex-wrap gap-1">
                      {mapping.scopes.map((scope) => (
                        <Badge key={scope} variant="blue">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Badge variant={mapping.enabled ? 'green' : 'slate'}>
                      {mapping.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-gray-400">
                    <p>{new Date(mapping.updated_at).toLocaleString()}</p>
                    <p>{mapping.updated_by_email ?? '—'}</p>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <ActionButton onClick={() => openEdit(mapping)}>Edit</ActionButton>
                    <ActionDivider />
                    <ActionButton
                      tone={mapping.enabled ? 'amber' : 'green'}
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({
                          mappingId: mapping.id,
                          input: { enabled: !mapping.enabled },
                        })
                      }
                    >
                      {mapping.enabled ? 'Disable' : 'Enable'}
                    </ActionButton>
                    <ActionDivider />
                    <ActionButton
                      tone="red"
                      disabled={remove.isPending}
                      onClick={() => deleteMapping(mapping)}
                    >
                      Delete
                    </ActionButton>
                  </Td>
                </tr>
              ))}
              {mappings.length === 0 ? (
                <tr>
                  <Td colSpan={6} className="py-8 text-center text-sm text-gray-400">
                    No confidential delegation mappings yet.
                  </Td>
                </tr>
              ) : null}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>

      {update.isError || remove.isError ? (
        <p role="alert" className="text-sm text-red-600">
          The requested mapping change failed. Refresh the page and try again.
        </p>
      ) : null}

      <ConfidentialDelegationFormDialog
        mapping={editing}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}
