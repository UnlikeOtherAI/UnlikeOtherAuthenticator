import { expandTeamRedirectTemplate } from '../utils/team-redirect-template.js';
import { resolveTeamById } from './team-hostname.service.js';

type TeamRedirectConfig = {
  domain: string;
  login_flow?: { team_redirect?: { redirect_url: string; template: string } };
};

/**
 * Where a finished sign-in delivers its authorization code.
 *
 * Returns the team's own address only when the config declares a template for
 * exactly this redirect URL and the sign-in resolved a team whose address UOA
 * itself would resolve (`resolveTeamById`: the product's namespace, ACTIVE
 * rows, an unambiguous organisation label). Otherwise the requested URL.
 */
export async function resolveTeamRedirectUrl(
  params: { config: TeamRedirectConfig; redirectUrl: string; orgId?: string; teamId?: string },
  deps: Parameters<typeof resolveTeamById>[1] = {},
): Promise<string> {
  const rule = params.config.login_flow?.team_redirect;
  if (!rule || rule.redirect_url !== params.redirectUrl || !params.orgId || !params.teamId) {
    return params.redirectUrl;
  }
  const team = await resolveTeamById({ domain: params.config.domain, teamId: params.teamId }, deps);
  if (!team || team.orgId !== params.orgId) return params.redirectUrl;
  return expandTeamRedirectTemplate(rule.template, team) ?? params.redirectUrl;
}
