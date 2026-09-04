import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import {
  adminService,
  type AutomaticMembershipAction,
  type AutomaticMembershipRule,
  type AutomaticMembershipScope,
} from '../../services/admin-service';
import { ApiRequestError } from '../../services/api-client';
import { useAdminUi } from '../shell/admin-ui';

type Props = { orgId: string; scope: AutomaticMembershipScope; teamId?: string };

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not checked yet';
}

function stateTone(state: AutomaticMembershipRule['state']): string {
  if (state === 'active') return 'bg-green-50 text-green-700';
  if (state === 'suspended' || state === 'revoked') return 'bg-red-50 text-red-700';
  return 'bg-amber-50 text-amber-700';
}

export function AutomaticMembershipSection({ orgId, scope, teamId }: Props) {
  const queryClient = useQueryClient();
  const { confirm } = useAdminUi();
  const [domain, setDomain] = useState('');
  const [notificationEmail, setNotificationEmail] = useState('');
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const queryKey = ['admin', 'automatic-membership', orgId, scope, teamId] as const;
  const rulesQuery = useQuery({
    queryKey,
    queryFn: () => adminService.getAutomaticMembership(orgId, scope, teamId),
  });
  const teamsQuery = useQuery({
    queryKey: ['admin', 'automatic-membership-teams', orgId],
    queryFn: () => adminService.getAutomaticMembershipTeams(orgId),
    enabled: scope === 'organisation',
  });
  const action = useMutation({
    mutationFn: (input: { action: AutomaticMembershipAction; payload: Record<string, unknown> }) =>
      adminService.controlAutomaticMembership(orgId, scope, input.action, input.payload, teamId),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'automatic-membership-teams', orgId] });
    },
    onError: (reason) => {
      setError(
        reason instanceof ApiRequestError && reason.code === 'AUTOMATIC_MEMBERSHIP_CONTROL_NOT_CONFIGURED'
          ? 'Automatic team access is not configured for this deployment.'
          : 'The automatic access change was not accepted. No memberships were removed.',
      );
    },
  });
  const submitCreate = () => {
    const payload: Record<string, unknown> = {
      domain: domain.trim(),
      notification_email: notificationEmail.trim() || null,
    };
    if (scope === 'organisation') payload.team_ids = selectedTeams;
    action.mutate({ action: 'create', payload });
  };
  const run = (next: AutomaticMembershipAction, rule: AutomaticMembershipRule) => {
    const dangerous = next === 'activate' || next === 'revoke' || next === 'release';
    const invoke = () => action.mutate({ action: next, payload: { rule_id: rule.id } });
    if (dangerous) {
      const text = next === 'activate'
        ? 'Activating starts a safe, resumable backfill. Matching verified users receive normal member access only.'
        : next === 'release'
          ? 'Releasing domain ownership stops this organisation from using the domain. Existing memberships stay unchanged.'
          : 'Revoking stops future automatic provisioning. Existing memberships stay unchanged.';
      confirm(`${next[0].toUpperCase()}${next.slice(1)} automatic access?`, text, invoke);
      return;
    }
    invoke();
  };

  if (rulesQuery.isLoading) return <p className="text-sm text-gray-400">Loading automatic team access...</p>;
  if (rulesQuery.isError) return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">Automatic team access is unavailable. No memberships were changed.</p>;
  const rules = rulesQuery.data?.rules ?? [];
  const teams = teamsQuery.data?.teams ?? [];
  return (
    <section aria-label="Automatic team access after sign-in" className="space-y-5">
      <Card>
        <CardHeader><span className="text-sm font-semibold text-gray-900">Automatic team access after sign-in</span></CardHeader>
        <div className="space-y-4 p-5 text-sm text-gray-600">
          <p>A DNS-verified company domain can grant matching users normal member access after sign-in. A domain does not authenticate a person, and it never grants admin or owner access.</p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 font-medium text-gray-700">Email domain<input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example.com" className="rounded-md border border-gray-300 px-3 py-2 font-normal" /></label>
            <label className="grid gap-1 font-medium text-gray-700">Notification email <span className="font-normal text-gray-400">(optional; does not verify ownership)</span><input value={notificationEmail} onChange={(event) => setNotificationEmail(event.target.value)} type="email" className="rounded-md border border-gray-300 px-3 py-2 font-normal" /></label>
          </div>
          {scope === 'organisation' ? <fieldset><legend className="mb-2 font-medium text-gray-700">Teams to receive normal member access</legend><div className="grid gap-2 sm:grid-cols-2">{teams.map((team) => <label key={team.external_team_id} className="flex items-center gap-2"><input type="checkbox" checked={selectedTeams.includes(team.external_team_id)} onChange={() => setSelectedTeams((current) => current.includes(team.external_team_id) ? current.filter((id) => id !== team.external_team_id) : [...current, team.external_team_id])} />{team.name}</label>)}</div></fieldset> : null}
          <Button variant="primary" disabled={action.isPending || !domain.trim() || (scope === 'organisation' && selectedTeams.length === 0)} onClick={submitCreate}>{action.isPending ? 'Saving...' : 'Create DNS verification rule'}</Button>
        </div>
      </Card>
      {error ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p> : null}
      {rules.length === 0 ? <p className="rounded-md border border-dashed border-gray-300 p-5 text-sm text-gray-500">No automatic access rules are configured.</p> : rules.map((rule) => <RuleCard key={rule.id} rule={rule} pending={action.isPending} onRun={run} scope={scope} teams={teams} onUpdate={(payload) => action.mutate({ action: 'update', payload: { rule_id: rule.id, ...payload } })} />)}
      {(rulesQuery.data?.audit?.length ?? 0) > 0 ? <Card><CardHeader><span className="text-sm font-semibold text-gray-900">Recent audit history</span></CardHeader><ul className="divide-y divide-gray-100">{rulesQuery.data?.audit?.map((entry) => <li key={entry.id} className="px-5 py-3 text-sm"><strong>{entry.action}</strong><span className="ml-2 text-gray-500">{formatDate(entry.created_at)}</span>{entry.detail ? <p className="mt-1 text-gray-500">{entry.detail}</p> : null}</li>)}</ul></Card> : null}
    </section>
  );
}

function RuleCard({ rule, pending, onRun, scope, teams, onUpdate }: { rule: AutomaticMembershipRule; pending: boolean; onRun: (action: AutomaticMembershipAction, rule: AutomaticMembershipRule) => void; scope: AutomaticMembershipScope; teams: Array<{ external_team_id: string; name: string }>; onUpdate: (payload: Record<string, unknown>) => void }) {
  const [notificationEmail, setNotificationEmail] = useState(rule.notification_email ?? '');
  const [teamIds, setTeamIds] = useState(rule.team_ids);
  return <Card><CardHeader><div><span className="font-semibold text-gray-900">{rule.domain}</span><span className={`ml-2 rounded-full px-2 py-1 text-xs font-medium ${stateTone(rule.state)}`}>{rule.state}</span></div><div className="flex gap-2"><Button size="sm" disabled={pending} onClick={() => onRun('verify', rule)}>Verify DNS</Button><Button size="sm" disabled={pending} onClick={() => onRun('rotate', rule)}>Rotate challenge</Button>{rule.state === 'active' ? <Button size="sm" disabled={pending} onClick={() => onRun('suspend', rule)}>Suspend</Button> : <Button size="sm" variant="primary" disabled={pending || rule.state !== 'verified'} onClick={() => onRun('activate', rule)}>Activate & backfill</Button>}<Button size="sm" variant="danger" disabled={pending} onClick={() => onRun('revoke', rule)}>Revoke</Button></div></CardHeader><div className="space-y-3 p-5 text-sm text-gray-600">{rule.dns ? <div className="rounded-md bg-gray-50 p-3"><p className="font-medium text-gray-800">DNS TXT record</p><code className="block break-all">{rule.dns.record_name}</code><code className="block break-all">{rule.dns.record_value}</code></div> : null}<p>Last check: {formatDate(rule.last_check_at)}{rule.last_check_error ? ` — ${rule.last_check_error}` : ''}</p><p>Verification expires: {formatDate(rule.verification_expires_at)}</p><details><summary className="cursor-pointer font-medium text-indigo-700">Edit notification and team mapping</summary><div className="mt-3 grid gap-3"><label className="grid gap-1">Notification email (optional)<input value={notificationEmail} onChange={(event) => setNotificationEmail(event.target.value)} type="email" className="rounded-md border border-gray-300 px-3 py-2" /></label>{scope === 'organisation' ? <fieldset><legend className="mb-1">Teams</legend>{teams.map((team) => <label key={team.external_team_id} className="mr-4 inline-flex items-center gap-2"><input type="checkbox" checked={teamIds.includes(team.external_team_id)} onChange={() => setTeamIds((current) => current.includes(team.external_team_id) ? current.filter((id) => id !== team.external_team_id) : [...current, team.external_team_id])} />{team.name}</label>)}</fieldset> : null}<div><Button size="sm" disabled={pending || (scope === 'organisation' && teamIds.length === 0)} onClick={() => onUpdate({ notification_email: notificationEmail.trim() || null, ...(scope === 'organisation' ? { team_ids: teamIds } : {}) })}>Save rule</Button></div></div></details>{rule.backfill ? <p>Backfill: {rule.backfill.status} · processed {rule.backfill.processed}, granted {rule.backfill.granted}, failed {rule.backfill.failed}{rule.backfill.error ? ` — ${rule.backfill.error}` : ''}</p> : null}<div><Button size="sm" variant="danger" disabled={pending} onClick={() => onRun('release', rule)}>Release domain ownership</Button></div></div></Card>;
}
