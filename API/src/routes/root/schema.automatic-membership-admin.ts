import type { EndpointSchema } from './schema.js';

const auth = 'UOA Admin superuser bearer. The browser calls UOA only; UOA signs the server-to-server Nessie bridge request and records the UOA actor subject.';

export const automaticMembershipAdminEndpoints: EndpointSchema[] = [
  {
    method: 'GET', path: '/internal/admin/organisations/:orgId/automatic-membership',
    description: 'Read Nessie automatic-team-access rules, persistent DNS instructions, aggregate backfill status/failures, and bounded audit history for one UOA organisation.', auth,
    response: { 200: '{ rules, audit? }; never returns a broad matching-person list', '404': 'Feature bridge is not configured' },
  },
  {
    method: 'GET', path: '/internal/admin/organisations/:orgId/automatic-membership/teams',
    description: 'Read the exact UOA-owned teams selectable by an organisation-scoped automatic-access rule.', auth,
    response: { 200: '{ teams: [{ external_team_id, name }] }' },
  },
  {
    method: 'POST', path: '/internal/admin/organisations/:orgId/automatic-membership',
    description: 'Proxy an organisation rule action to Nessie after binding the current UOA admin subject and exact organisation.', auth,
    body: { action: 'create | update | verify | rotate | activate | suspend | revoke | release', payload: 'action-specific safe control payload (required object)' },
    response: { 200: '{ rule? | rules?, audit?, message? }' },
  },
  {
    method: 'GET', path: '/internal/admin/organisations/:orgId/teams/:teamId/automatic-membership',
    description: 'Read automatic team access for one exact UOA team.', auth,
    response: { 200: '{ rules, audit? }; never returns a broad matching-person list' },
  },
  {
    method: 'POST', path: '/internal/admin/organisations/:orgId/teams/:teamId/automatic-membership',
    description: 'Proxy a team rule action to Nessie after binding the current UOA admin subject and exact organisation/team.', auth,
    body: { action: 'create | update | verify | rotate | activate | suspend | revoke | release', payload: 'action-specific safe control payload (required object)' },
    response: { 200: '{ rule? | rules?, audit?, message? }' },
  },
];
