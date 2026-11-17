import { describe, expect, it } from 'vitest';

import {
  expandTeamRedirectTemplate,
  teamRedirectTemplateProblem,
} from '../../src/utils/team-redirect-template.js';

const redirectUrl = 'https://product.example/login?arrive=team';
const problem = (template: string, registered = redirectUrl) =>
  teamRedirectTemplateProblem({ template, redirectUrl: registered });

describe('team redirect template', () => {
  it('accepts an organisation subdomain of the registered host with a team path segment', () => {
    expect(problem('https://{org}.product.example/{team}/login')).toBeNull();
    expect(problem('https://{org}.product.example/login')).toBeNull();
  });

  it.each([
    ['no organisation', 'https://product.example/{team}/login'],
    ['two organisations', 'https://{org}.product.example/{org}/login'],
    ['two teams', 'https://{org}.product.example/{team}/{team}'],
    ['an unknown placeholder', 'https://{org}.product.example/{user}/login'],
    ['a stray brace', 'https://{org}.product.example/{team/login'],
    ['another host', 'https://{org}.attacker.example/{team}/login'],
    ['a look-alike suffix', 'https://{org}.evil-product.example/{team}/login'],
    ['a deeper subdomain', 'https://{org}.teams.product.example/{team}/login'],
    ['the organisation as a partial label', 'https://x-{org}.product.example/{team}/login'],
    ['the team in the host', 'https://{org}.{team}.product.example/login'],
    ['the organisation in the path', 'https://product.example/{org}/login'],
    ['the team as a partial segment', 'https://{org}.product.example/t-{team}/login'],
    ['plain http', 'http://{org}.product.example/{team}/login'],
    ['a custom scheme', 'product://{org}.product.example/{team}/login'],
    ['a query', 'https://{org}.product.example/{team}/login?next=1'],
    ['a fragment', 'https://{org}.product.example/{team}/login#x'],
    ['credentials', 'https://user@{org}.product.example/{team}/login'],
    ['no path', 'https://{org}.product.example'],
    ['an upper-case host', 'https://{org}.Product.example/{team}/login'],
    ['a default port', 'https://{org}.product.example:443/{team}/login'],
    ['a dot segment', 'https://{org}.product.example/{team}/../login'],
  ])('rejects %s', (_name, template) => {
    expect(problem(template)).not.toBeNull();
  });

  it('requires the registered redirect URL to be https and to share the port', () => {
    expect(problem('https://{org}.product.example/{team}/login', 'product://auth/callback')).not.toBeNull();
    expect(
      problem('https://{org}.product.example/{team}/login', 'https://product.example:8443/login'),
    ).not.toBeNull();
    expect(
      problem('https://{org}.product.example:8443/{team}/login', 'https://product.example:8443/login'),
    ).toBeNull();
  });

  it('fills the template with the team labels', () => {
    expect(
      expandTeamRedirectTemplate('https://{org}.product.example/{team}/login', {
        orgSlug: 'acme',
        teamSlug: 'design',
      }),
    ).toBe('https://acme.product.example/design/login');
    expect(
      expandTeamRedirectTemplate('https://{org}.product.example/login', {
        orgSlug: 'acme',
        teamSlug: 'design',
      }),
    ).toBe('https://acme.product.example/login');
  });

  it.each([
    ['a dot', 'acme.evil', 'design'],
    ['a slash', 'acme', 'design/x'],
    ['upper case', 'Acme', 'design'],
    ['an empty label', '', 'design'],
    ['a leading hyphen', '-acme', 'design'],
    ['a query', 'acme', 'design?x=1'],
  ])('refuses labels that are not slugs: %s', (_name, orgSlug, teamSlug) => {
    expect(
      expandTeamRedirectTemplate('https://{org}.product.example/{team}/login', { orgSlug, teamSlug }),
    ).toBeNull();
  });
});
