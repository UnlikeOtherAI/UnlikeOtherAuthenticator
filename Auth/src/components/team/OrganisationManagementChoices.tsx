import React, { useState } from 'react';

import { Button } from '../ui/Button.js';
import { useAccessTranslation } from '../../hooks/use-access-translation.js';
import { usePopup, type SessionChoices } from '../../hooks/use-popup.js';
import { startOrganisationManagement, type AuthFlowQuery } from '../../utils/api.js';
import { isRecord } from '../../utils/organisation-access-schema.js';
import { interpretTeamResponse, isExpiredBridge, type TeamResponseOutcome } from '../../utils/team-response.js';

/** Server hints name destinations; the start endpoint independently checks current ownership. */
export function manageableOrganisations(choices: SessionChoices) {
  const organisations = new Map<string, string>();
  for (const org of choices.manageable_orgs ?? []) {
    if (typeof org.orgId === 'string' && typeof org.orgName === 'string' && org.orgName.trim()) {
      organisations.set(org.orgId, org.orgName);
    }
  }
  for (const team of choices.teams) {
    if (team.can_manage_sso === true && typeof team.orgName === 'string' && team.orgName.trim()) {
      organisations.set(team.orgId, team.orgName);
    }
  }
  return [...organisations].map(([orgId, orgName]) => ({ orgId, orgName }));
}

export function OrganisationManagementChoices(props: {
  choices: SessionChoices;
  loginToken: string;
  query: AuthFlowQuery;
  targetOrgId?: string;
  onOutcome: (outcome: TeamResponseOutcome) => void;
}): React.JSX.Element | null {
  const t = useAccessTranslation();
  const popup = usePopup();
  const clientDomain = isRecord(popup.config) && typeof popup.config.domain === 'string' ? popup.config.domain : null;
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const organisations = manageableOrganisations(props.choices)
    .filter(org => !props.targetOrgId || org.orgId === props.targetOrgId);
  if (!props.targetOrgId && organisations.length === 0) return null;

  const useAnotherAccount = () => {
    popup.setSessionChoices(null);
    popup.setLoginToken(null);
    popup.setView('login');
  };
  const start = async (orgId: string) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const result = await startOrganisationManagement(
        { login_token: props.loginToken, org_id: orgId }, props.query,
      );
      if (!result.ok) {
        if (isExpiredBridge(result.status)) props.onOutcome({ kind: 'expired' });
        else setFailed(true);
        return;
      }
      const outcome = interpretTeamResponse(result.data);
      if (outcome.kind === 'error') setFailed(true);
      else props.onOutcome(outcome);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return <section className="flex flex-col gap-3">
    <h1 className="text-lg font-semibold">
      {t(props.targetOrgId ? 'managementTitle' : 'managementSection')}
    </h1>
    {props.targetOrgId ? <p className="text-sm text-[var(--uoa-color-muted)]">
      {t(organisations.length ? 'managementHint' : 'managementUnavailable')}
    </p> : null}
    {organisations.map(org => <div key={org.orgId} className="flex flex-col gap-2">
      <p className="font-medium">{clientDomain ? t('destination', {org: org.orgName,domain: clientDomain}) : org.orgName}</p>
      <Button disabled={pending} onClick={() => void start(org.orgId)}>
        {t('managementContinue')}
      </Button>
    </div>)}
    {failed ? <p role="alert" className="text-sm text-[var(--uoa-color-danger)]">
      {t('managementFailed')}
    </p> : null}
    {props.targetOrgId ? <Button variant="secondary" disabled={pending} onClick={useAnotherAccount}>
      {t('managementOther')}
    </Button> : null}
  </section>;
}
