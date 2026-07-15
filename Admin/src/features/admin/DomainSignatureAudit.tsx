import { Card } from '../../components/ui/Card';
import { DataTable, Td } from '../../components/ui/Table';
import type { DomainSignatureAuditEvent } from './types';

export function DomainSignatureAudit({ events }: { events: DomainSignatureAuditEvent[] }) {
  return (
    <Card>
      <DataTable headers={['When', 'Actor', 'Action', 'Target', 'Details']}>
        {events.map((event) => (
          <tr key={event.id}>
            <Td className="whitespace-nowrap text-xs text-gray-500">{new Date(event.created_at).toLocaleString()}</Td>
            <Td className="text-xs">{event.actor_email}</Td>
            <Td><code className="text-xs">{event.action}</code></Td>
            <Td>
              <p className="text-xs">{event.target_type}</p>
              <code className="block max-w-40 truncate text-[11px] text-gray-400" title={event.target_id}>{event.target_id}</code>
            </Td>
            <Td><code className="block max-w-72 whitespace-pre-wrap break-all text-[11px] text-gray-500">{event.metadata ? JSON.stringify(event.metadata) : '—'}</code></Td>
          </tr>
        ))}
        {events.length === 0 ? (
          <tr><Td colSpan={5} className="text-sm text-gray-400">No signature administration events recorded.</Td></tr>
        ) : null}
      </DataTable>
    </Card>
  );
}
