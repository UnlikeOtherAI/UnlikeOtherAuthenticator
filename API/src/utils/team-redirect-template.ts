import { SLUG_SHAPE_RE } from '@unlikeotherai/slug';

import { tryParseRedirectUrl } from './http-url.js';

/**
 * Team redirect templates (`login_flow.team_redirect` in the signed config).
 *
 * A product whose teams live at their own addresses cannot register those
 * addresses as `redirect_urls`: the list is matched byte-for-byte and the
 * addresses are made at runtime, from labels UOA owns. Without this the product
 * received every authorization code on one shared page and then had to move
 * the browser to the team's address itself, with a second sign-in handoff.
 *
 * The claim names one registered redirect URL and the template that upgrades
 * it. A sign-in that asks for that URL and finishes inside a team gets its
 * code at the template filled in with the team's own labels; any other sign-in
 * — another redirect URL, no team, a team with no unambiguous address — gets
 * the registered URL exactly as before. The code is bound to the address it is
 * delivered to, so the token exchange presents that address as `redirect_url`.
 *
 * The template can only name a direct subdomain of the registered URL's own
 * host, so it adds no destination the product has not already been approved
 * for; the labels come from UOA's own rows, never from the request.
 */

const ORG_PLACEHOLDER = '{org}';
const TEAM_PLACEHOLDER = '{team}';
// Valid slugs that no template literal can contain, used to parse a template
// as an ordinary URL without the placeholders' braces.
const ORG_PROBE = 'uoa-org-placeholder';
const TEAM_PROBE = 'uoa-team-placeholder';

const count = (value: string, needle: string): number => value.split(needle).length - 1;

const fill = (template: string, org: string, team: string): string =>
  template.replace(ORG_PLACEHOLDER, org).replace(TEAM_PLACEHOLDER, team);

/**
 * Why a template is unusable beside its registered redirect URL, or `null`
 * when it is valid. Called by the config schema, so a bad template rejects the
 * config rather than failing a sign-in later.
 */
export function teamRedirectTemplateProblem(params: {
  template: string;
  redirectUrl: string;
}): string | null {
  const { template } = params;
  if (count(template, ORG_PLACEHOLDER) !== 1) return 'template must contain {org} exactly once';
  if (count(template, TEAM_PLACEHOLDER) > 1) return 'template may contain {team} at most once';
  if (/[{}]/.test(fill(template, '', ''))) return 'template may only use {org} and {team}';
  if (template.includes(ORG_PROBE) || template.includes(TEAM_PROBE)) {
    return 'template uses a reserved label';
  }

  const probe = fill(template, ORG_PROBE, TEAM_PROBE);
  const url = tryParseRedirectUrl(probe);
  if (!url || url.protocol !== 'https:') return 'template must be an https URL';
  // The filled template is stored on the authorization code and compared
  // byte-for-byte at the token exchange, so it has to be the form a browser
  // reports for the address it landed on: lower-case host, no default port,
  // an explicit path, no query or fragment.
  if (url.username || url.password || url.search || url.hash || url.href !== probe) {
    return 'template must be a plain canonical URL with a path and no query or fragment';
  }

  const registered = tryParseRedirectUrl(params.redirectUrl);
  if (!registered || registered.protocol !== 'https:') {
    return 'redirect_url must be an https URL';
  }
  if (url.host !== `${ORG_PROBE}.${registered.host}`) {
    return '{org} must be the subdomain directly under the redirect_url host';
  }
  const segments = url.pathname.split('/');
  if (segments.some((segment) => segment.includes(ORG_PROBE))) {
    return '{org} may only appear in the host';
  }
  if (
    template.includes(TEAM_PLACEHOLDER) &&
    segments.filter((segment) => segment === TEAM_PROBE).length !== 1
  ) {
    return '{team} must be one whole path segment';
  }
  return null;
}

/** The template filled with a team's labels, or `null` when they cannot form an address. */
export function expandTeamRedirectTemplate(
  template: string,
  labels: { orgSlug: string; teamSlug: string },
): string | null {
  if (!SLUG_SHAPE_RE.test(labels.orgSlug) || !SLUG_SHAPE_RE.test(labels.teamSlug)) return null;
  const expanded = fill(template, labels.orgSlug, labels.teamSlug);
  const url = tryParseRedirectUrl(expanded);
  return url && url.protocol === 'https:' && url.href === expanded ? expanded : null;
}
