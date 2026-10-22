import type { EndpointSchema } from './schema.js';

// Split from `schema.internal-admin.ts`, which sits at the 500-line limit (CLAUDE.md).
export const internalAdminAuthFunnelEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/internal/admin/auth-funnel',
    description:
      'Sign-up and sign-in funnel: event counts per step and outcome for a UTC day range, optionally for one client domain (Docs/Auth/signup-funnel-metrics.md)',
    auth: 'Authorization: Bearer <access_token>; ADMIN_AUTH_DOMAIN superuser (same boundary as every /internal/admin read)',
    query: {
      from: 'YYYY-MM-DD (optional, UTC, inclusive; default 29 days before `to`)',
      to: 'YYYY-MM-DD (optional, UTC, inclusive; default today)',
      domain: 'string (optional) — narrow totals and days to one client domain',
    },
    response: {
      200: '{ from, to, domain: string | null, domains: string[] (every domain with data in the range), totals: [{ step, outcome, count }] in funnel order, days: [{ day, step, outcome, count }] }',
      400: 'INVALID_DATE_RANGE — malformed day, `from` after `to`, or a range longer than 366 days',
      '401/403': '401 when bearer token is missing/invalid; 403 when token is not an admin-domain superuser',
    },
    notes:
      'Steps: flow_started, register_submitted, email_start_submitted, login_submitted, registration_email, email_link_opened, set_password, social_started, sign_in_completed, code_exchange. Counts only — no email, IP, user id, token or flow id is stored, and one person can be counted more than once.',
  },
];
