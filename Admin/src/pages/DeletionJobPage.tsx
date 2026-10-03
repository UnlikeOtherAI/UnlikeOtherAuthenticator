import { lifecycleErrorMessage } from '../features/admin/lifecycle-errors';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { createApiClient } from '../services/api-client';

const api = createApiClient();
type Job = {
  id: string; status: string; scope: string; blockers: string[];
  preview: { name?: string; retainedEvidence: { model: string; count: number; reason: string }[] };
  participants: { domain: string; acknowledgedAt: string | null; outcome: string | null; retainedEvidence?: { label: string; count: number; reason: string }[] }[];
};

/** Independent of entity detail: successful erasure may remove that record entirely. */
export function DeletionJobPage() {
  const { jobId } = useParams();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const path = `/internal/admin/lifecycle/deletion-jobs/${encodeURIComponent(jobId ?? '')}`;
  const query = useQuery({ queryKey: ['admin', 'deletion-job', jobId], queryFn: () => api.get<Job>(path),
    refetchInterval: (q) => q.state.data && q.state.data.status !== 'COMPLETE' ? 10_000 : false });
  async function retry() {
    setPending(true); setError('');
    try {
      const result = await api.post<Job>(`${path}/retry`);
      client.setQueryData(['admin', 'deletion-job', jobId], result);
      await client.invalidateQueries({ queryKey: ['admin'] });
    } catch (failure) {
      setError(lifecycleErrorMessage(failure));
      await query.refetch();
    } finally { setPending(false); }
  }
  const job = query.data;
  return <>
    <PageHeader title="Deletion progress" description="This record stays available after the original account, team, or organisation is removed." />
    {query.isError ? <p role="alert">Could not load deletion progress. <Button onClick={() => void query.refetch()}>Retry</Button></p> : null}
    {query.isLoading ? <p role="status">Loading deletion progress…</p> : null}
    {job ? <Card className="space-y-4 p-5">
      <h2 className="font-semibold">{job.preview.name ?? 'Deletion request'}</h2>
      <p className="break-all">Deletion job {job.id}: {job.status.toLowerCase().replaceAll('_', ' ')}</p>
      {error ? <p role="alert" className="text-red-700">{error}</p> : null}
      {job.blockers.map((blocker) => <p key={blocker} role="alert">{blocker}</p>)}
      <ul className="space-y-2">{job.participants.map((participant) => <li className="break-words" key={participant.domain}>
        {participant.domain}: {participant.acknowledgedAt ? participant.outcome?.toLowerCase().replaceAll('_', ' ') : 'waiting for product acknowledgement'}
        {participant.outcome === 'RETAINED_EVIDENCE' ? <ul>{participant.retainedEvidence?.length ? participant.retainedEvidence.map((record, index) => <li key={index}>{record.label}: {record.count}. {record.reason}</li>) : <li>Product reported retained evidence; details unavailable.</li>}</ul> : null}
      </li>)}</ul>
      {job.preview.retainedEvidence.length ? <div><h3 className="font-semibold">Restricted retained evidence</h3><ul className="space-y-2">{job.preview.retainedEvidence.map((record, index) =>
        <li key={index}>{record.model.replace(/([a-z])([A-Z])/g, '$1 $2')}: {record.count}. {record.reason}</li>)}</ul></div> : null}
      {job.status === 'COMPLETE' ? <p>Operational deletion completed. Listed protected evidence remains restricted.</p> :
        <Button disabled={pending || job.status === 'WAITING_FOR_PRODUCTS'} onClick={() => void retry()}>{pending ? 'Continuing deletion…' : 'Finish or retry deletion'}</Button>}
      <p><Link className="text-indigo-600 hover:underline" to={job.scope === 'USER' ? '/users' : job.scope === 'TEAM' ? '/teams' : '/organisations'}>Return to directory</Link></p>
    </Card> : null}
  </>;
}
