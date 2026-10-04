import { createLifecycleFixtures } from './lifecycle-fixtures';
import { createBillingFixtures } from './billing-fixtures';
import type { Page } from '@playwright/test';
import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';
import type { NativeApp } from '../src/schemas/native-app';

export const nativeApp: NativeApp = {
  id: 'native-1',
  identifier: 'com.example.browser',
  name: 'Fixture Browser',
  enabled: true,
  redirect_uris: ['http://127.0.0.1:9000/callback'],
  scopes: ['openid', 'profile', 'email'],
  methods: ['google', 'email_password'],
  allow_registration: true,
  primary_color: '#2563eb',
  background_color: '#ffffff',
  text_color: '#111827',
  icon_url: null,
  revision: 1,
};
const now = '2026-10-03T12:00:00.000Z';
const request = {
  id: 'request-1',
  domain: 'app.acme.com',
  status: 'ACCEPTED',
  contact_email: 'partner@example.test',
  kid: 'fixture-key',
  jwk_fingerprint: 'fixture-fingerprint',
  jwks_url: 'https://app.acme.com/jwks.json',
  config_url: 'https://app.acme.com/config',
  decline_reason: null,
  reviewed_at: now,
  reviewed_by_email: 'operator@example.test',
  client_domain_id: 'app.acme.com',
  submitted_at: now,
  last_seen_at: now,
  public_jwk: { kty: 'RSA', kid: 'fixture-key' },
  config_summary: { verified: true },
  pre_validation_result: { ok: true },
};
const signatures = {
  settings: {
    enabled: false,
    policy_revision: 1,
    retention_days: 90,
    created_at: now,
    updated_at: now,
  },
  agreements: [
    {
      id: 'agreement-1',
      title: 'Fixture agreement',
      description: 'Terms',
      display_order: 1,
      required_for_access: true,
      created_at: now,
      updated_at: now,
      versions: [],
    },
  ],
  audit_events: [],
};

/** All browser API calls terminate here. Unexpected writes fail closed. */
export async function installFixtures(page: Page) {
  const data = structuredClone(mockAdminData);
  const lifecycle = createLifecycleFixtures();
  data.domains.forEach((domain) => {
    domain.id = domain.name;
  });
  const teams = data.organisations.flatMap((org) =>
    org.teams.map((team) => ({ ...team, orgName: org.name })),
  );
  const billing = createBillingFixtures();
  const invoices: unknown[] = [billing.invoice];
  const taxPolicies: Array<Record<string, unknown>> = [];
  const calculations: unknown[] = [];
  const payments: unknown[] = [];
  const activations: unknown[] = [];
  const seatCapacityWrites: unknown[] = [];
  const seatSubscription = {
    id: 'seat-fixture-1', service_id: 'billing-1',
    organisation: { id: 'o1', name: 'Acme Research' }, team: null,
    source: 'manual' as const, seat_policy: 'fixed' as const,
    seat_charge_timing: 'full_month' as const, baseline_member_count: 4,
    activated_at: now, ended_at: null, current_capacity: 5,
    capacity_revisions: [{ id: 'revision-1', quantity: 5, effective_at: now }],
  };
  const memberships: unknown[] = [];
  let paymentFailures = 1;
  const native = structuredClone(nativeApp);
  const unexpected: string[] = [];
  const errors: string[] = [];
  let nativeFailures = 0;
  let nativeWrites = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    unexpected.push(`External request ${url.origin}`);
    return route.abort();
  });
  await page.route('**/internal/admin/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.replace('/internal/admin', ''));
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.startsWith('/lifecycle/')) return lifecycle.handle(route, path);
    if (req.method() !== 'GET') {
      if (path === '/billing/credit-invoice-tax-policies' && req.method() === 'POST') {
        const input = req.postDataJSON();
        if (input.account_id !== 'account-1' ||
            input.issuer_profile_id !== billing.issuer.id ||
            input.jurisdiction_country !== 'GB' ||
            input.treatment !== 'INCLUSIVE_RATE' ||
            input.rate_bps !== 2000 ||
            input.legal_basis_reference !== 'Verified UK VAT treatment' ||
            input.effective_from !== '2026-10-04T00:00:00Z') {
          unexpected.push('Invalid tax policy payload');
          return json({ error: 'Invalid tax policy' }, 400);
        }
        const created = {
          ...input, id: 'tax-policy-1', version: 1, created_at: now,
          created_by_email: 'operator@example.test',
        };
        taxPolicies.push(created);
        return json(created, 201);
      }
      if (path === '/billing/seat-subscriptions/seat-fixture-1/capacity') {
        const input = req.postDataJSON();
        seatCapacityWrites.push(input);
        if (input.quantity !== 6) return json({ error: 'Invalid capacity' }, 400);
        seatSubscription.current_capacity = input.quantity;
        return json({ id: 'revision-2', quantity: input.quantity, effective_at: now });
      }
      if (path === '/billing/contracts/contract-1/versions/version-2/activate'
          && req.method() === 'POST') {
        const input = req.postDataJSON();
        activations.push(input);
        const draft = billing.contracts[0]?.versions[1];
        if (!draft || input.services?.length !== 1
            || input.services[0].service_id !== 'billing-1') {
          unexpected.push('Invalid future contract activation');
          return json({ error: 'Invalid activation' }, 400);
        }
        draft.actions = { activation_state: 'scheduled', activate: false };
        draft.services = [{ service_id: 'billing-1', service_identifier: 'deepwater',
          service_name: 'Fixture product', tariff_id: 'future-tariff',
          monthly_amount_minor: input.services[0].monthly_amount_minor,
          monthly_charge_basis: input.services[0].monthly_charge_basis,
          seat_policy: input.services[0].seat_policy ?? null,
          seat_charge_timing: input.services[0].seat_charge_timing ?? null,
          usage_payment_mode: input.services[0].usage_payment_mode,
          fixed_seat_quantity: input.services[0].fixed_seat_quantity ?? null,
          monthly_price: { amount_minor: input.services[0].monthly_amount_minor,
            amount: '60', currency: 'USD', display: '$60.00' } }];
        return json(draft);
      }
      if (path === '/users/u101/teams' && req.method() === 'POST') {
        const input = req.postDataJSON();
        memberships.push(input);
        if (memberships.length === 1) return json({ error: 'Synthetic membership failure' }, 503);
        const org = data.organisations.find((entry) => entry.id === input.orgId);
        const team = org?.teams.find((entry) => entry.id === input.teamId);
        const user = data.users.find((entry) => entry.id === 'u101');
        if (!org || !team || !user || !['member', 'admin'].includes(input.teamRole)) {
          unexpected.push('Invalid membership fixture payload');
          return json({ error: 'Invalid membership' }, 400);
        }
        const defaultTeam = org.teams.find((entry) => entry.isDefault);
        const names = [...new Set([defaultTeam?.name, team.name].filter((name): name is string => !!name))];
        org.members.push({ ...user, role: 'member', teams: names,
          teamRoles: { ...(defaultTeam ? { [defaultTeam.name]: 'member' as const } : {}), [team.name]: input.teamRole } });
        org.teams.forEach((entry) => { if (names.includes(entry.name)) entry.members += 1; });
        return json({ ok: true, userId: user.id, ...input });
      }
      if (path === '/billing/invoices/calculate') {
        const input = req.postDataJSON();
        calculations.push(input);
        const draft = { ...billing.invoice, id: 'draft-2', contract_id: input.contract_id,
          status: 'draft', invoice_number: null, issue_date: null, due_date: null, issued_at: null,
          payment_status: 'open', payments: [],
          actions: { issue: 'issue', download_pdf: false, void: false,
            payment_limits: { payment: null, refund: null, write_off: null } } };
        invoices.push(draft);
        return json(draft);
      }
      if (path === '/billing/invoices/invoice-1/payments') {
        payments.push(req.postDataJSON());
        if (paymentFailures-- > 0) return json({ error: 'Synthetic payment failure' }, 503);
        return json(billing.invoice);
      }
      if (path === '/native-apps/native-1' && req.method() === 'PUT') {
        nativeWrites += 1;
        if (nativeFailures > 0) {
          nativeFailures -= 1;
          return json({ error: 'Fixture rejected save' }, 503);
        }
        Object.assign(native, req.postDataJSON(), { revision: native.revision + 1 });
        return json(native);
      }
      unexpected.push(`${req.method()} ${path}`);
      return json({ error: 'Unexpected fixture write' }, 500);
    }
    if (path.endsWith('/avatar'))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#4f46e5"/></svg>',
      });
    if (path === '/dashboard') return json(data);
    if (path === '/domains') return json(data.domains);
    if (path.startsWith('/domains/')) {
      if (path.endsWith('/email'))
        return json({
          config: null,
          liveStatus: null,
          dnsRecords: null,
          adminCredentialsConfigured: false,
        });
      if (path.endsWith('/jwks')) return json([]);
      if (path.endsWith('/signatures/records')) return json({ data: [], next_cursor: null });
      if (path.endsWith('/signatures')) return json(signatures);
      const domain = data.domains.find((item) => path === `/domains/${item.name}`);
      if (domain)
        return json({
          domain,
          organisations: data.organisations.slice(0, 2),
          teams: teams.filter((team) => team.orgId === 'o1'),
          users: data.users,
        });
    }
    if (path === '/organisations') return json(data.organisations);
    const orgMatch = /^\/organisations\/([^/]+)(?:\/teams\/([^/]+))?$/.exec(path);
    if (orgMatch) {
      const org = data.organisations.find((item) => item.id === orgMatch[1]);
      return json(
        orgMatch[2] ? { org, team: org?.teams.find((item) => item.id === orgMatch[2]) } : org,
      );
    }
    if (path === '/teams') return json(teams);
    if (path === '/users') return json(data.users);
    if (path.startsWith('/users/'))
      return json(data.users.find((user) => path === `/users/${user.id}`));
    if (path === '/logs') return json(data.logs.map((log) => ({ ...log, userId: 'u101' })));
    if (path === '/handshake-errors') return json(data.handshakeErrors);
    if (path === '/settings')
      return json({
        apps: data.apps.map((app) => ({ ...app, audienceGroups: [] })),
        bans: data.bans,
      });
    if (path === '/native-apps') return json([native]);
    if (path === '/integration-requests')
      return json(url.searchParams.get('status') === 'PENDING' ? [] : [request]);
    if (path === '/integration-requests/request-1') return json(request);
    if (path === '/confidential-delegations') return json([]);
    if (path === '/api-keys') return json([]);
    if (path === '/superusers')
      return json([
        { userId: 'u101', email: 'alice@acme.com', name: 'Alice Chen', createdAt: now },
      ]);
    if (path === '/billing/services')
      return json([
        {
          id: 'billing-1',
          name: 'Fixture product',
          identifier: 'fixture',
          active: true,
          tariffs: [],
          assignments: [],
          app_keys: [],
          adjustments: [],
          stripe_catalogs: [],
          stripe_subscriptions: [],
          created_at: now,
          updated_at: now,
        },
      ]);
    if (path === '/billing/services/billing-1/seat-subscriptions')
      return json([seatSubscription]);
    if (path === '/billing/contracts') return json(billing.contracts);
    if (path === '/billing/invoice-issuer-profiles') return json([billing.issuer]);
    if (path === '/billing/credit-invoice-tax-policies') return json({
      accounts: [{ id: 'account-1', stripe_account_id: 'acct_fixture',
        livemode: false }],
      policies: taxPolicies,
    });
    if (path === '/billing/invoices') return json(invoices);
    if (path.endsWith('/invoice-profile'))
      return json({ error: 'No synthetic buyer profile' }, 404);
    if (path === '/bans') return json([...data.bans.emails, ...data.bans.ips]);
    if (path === '/search') return json([{ type: 'user', user: data.users[0] }]);
    unexpected.push(`GET ${path}`);
    return json({ error: 'Missing fixture' }, 404);
  });
  return {
    unexpected,
    errors,
    lifecycle,
    native,
    calculations,
    payments,
    activations,
    seatCapacityWrites,
    taxPolicies,
    memberships,
    failNextNativeSave: () => {
      nativeFailures = 1;
    },
    nativeWrites: () => nativeWrites,
  };
}
