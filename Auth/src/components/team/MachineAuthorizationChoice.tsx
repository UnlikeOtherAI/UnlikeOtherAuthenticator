import { useRef, useState } from 'react';
import { Button } from '../ui/Button.js';
import { usePopup, type SessionChoices } from '../../hooks/use-popup.js';
import { useMachineTranslation } from '../../i18n/machines.js';
import { request } from '../../utils/api.js';
import { interpretTeamResponse, type TeamResponseOutcome } from '../../utils/team-response.js';

export function MachineAuthorizationChoice(props: { choices: SessionChoices; loginToken: string;
  onOutcome: (outcome: TeamResponseOutcome) => void }) {
  const popup = usePopup(); const t = useMachineTranslation();
  const pending = useRef(false); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const teams = props.choices.teams.filter(team => !popup.machineRequestId || team.teamId === popup.teamHint);
  async function start(orgId: string, teamId: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false);
    try {
      const result = await request<unknown>('POST', '/auth/machines/start', {
        query: { config_url: popup.configUrl }, body: { login_token: props.loginToken,
          organization_id: orgId, team_id: teamId, ...(popup.machineRequestId ? { request_id: popup.machineRequestId } : {}) } });
      if (!result.ok) { setFailed(true); return; }
      const outcome = interpretTeamResponse(result.data);
      if (outcome.kind === 'error') setFailed(true); else props.onOutcome(outcome);
    } catch { setFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="flex flex-col gap-4">
    <h1 className="text-lg font-semibold">{t(popup.machineRequestId ? 'review' : 'title')}</h1>
    <p className="text-sm text-[var(--uoa-color-muted)]">{t(popup.machineRequestId ? 'requestTeamHint' : 'selectTeam')}</p>
    {popup.pendingEmail ? <p className="break-words text-sm text-[var(--uoa-color-muted)]">{t('wrongAccountIdentity', { email: popup.pendingEmail })}</p> : null}
    {teams.length === 0 ? <p className="text-sm text-[var(--uoa-color-muted)]">{t('wrongAccount')}</p> : null}
    {teams.map(team => <div key={team.teamId} className="flex flex-col gap-2">
      <p className="font-medium">{t('destination', { organization: team.orgName ?? '', team: team.name })}</p>
      <Button disabled={busy} onClick={() => void start(team.orgId, team.teamId)}>{t('continue')}</Button>
    </div>)}
    {failed ? <p role="alert" className="text-sm text-[var(--uoa-color-danger)]">{t('continueFailed')}</p> : null}
    <Button variant="secondary" disabled={busy} onClick={() => {
      popup.setLoginToken(null); popup.setSessionChoices(null); popup.setView('login');
    }}>{t('anotherAccount')}</Button>
  </section>;
}
