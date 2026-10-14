import { expect, test } from '@playwright/test';
import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';
import { installFixtures } from './fixtures';
import { settledScreenshot } from './audit-screenshot';

test('U10 Members separates account lifecycle from membership and keeps recovery navigation', async ({
  page,
}, info) => {
  // Explicitly check both servers owned by the existing audit configuration.
  for (const port of [5291, 5292]) {
    expect((await page.request.get(`http://127.0.0.1:${port}/`)).status()).toBe(200);
  }
  await installFixtures(page);
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'uoa-admin-session',
      JSON.stringify({
        accessToken: 'synthetic-admin',
        expiresAt: Date.now() + 600000,
      }),
    ),
  );
  await page.route('**/internal/admin/session', (route) =>
    route.fulfill({
      json: {
        adminUser: { email: 'operator@example.test' },
      },
    }),
  );
  const org = structuredClone(mockAdminData.organisations[0]);
  if (!org) throw new Error('Missing organisation fixture');
  org.members = org.members.map((member) => ({
    ...member,
    status: member.id === 'u102' ? 'disabled' : 'active',
    membershipStatus:
      member.id === 'u103' ? 'removed' : member.id === 'u104' ? 'deactivated' : 'active',
  }));
  const unknownMember = org.members.find((member) => member.id === 'u105');
  if (!unknownMember) throw new Error('Missing unknown-membership fixture');
  Reflect.deleteProperty(unknownMember, 'membershipStatus');
  await page.route('**/internal/admin/organisations/o1', (route) => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: org });
  });
  await page.route('**/internal/admin/organisations', (route) =>
    route.fulfill({
      json: mockAdminData.organisations.map((entry) => (entry.id === org.id ? org : entry)),
    }),
  );
  const disabledUser = mockAdminData.users.find((user) => user.id === 'u102');
  if (!disabledUser) throw new Error('Missing disabled-user fixture');
  await page.route('**/internal/admin/users/u102', (route) => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: { ...disabledUser, status: 'disabled' } });
  });
  await page.route('**/internal/admin/lifecycle/USER/u102', (route) => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({
      json: {
        status: 'DISABLED',
        reason: 'Fixture access review',
        internalNote: null,
        deletionJobId: null,
      },
    });
  });
  await page.goto('/organisations/o1?tab=members');
  await expect(page.getByRole('columnheader', { name: 'Account status' })).toHaveCount(1);
  await expect(page.getByRole('columnheader', { name: 'Membership', exact: true })).toHaveCount(1);
  for (const [name, account, membership, role] of [
    ['Alice Chen', 'active', 'active', 'owner'],
    ['Bob Smith', 'disabled', 'active', 'admin'],
    ['Carol Davis', 'active', 'removed', 'member'],
    ['Dan Lee', 'active', 'deactivated', 'member'],
    ['Eva Torres', 'active', 'Unavailable', 'member'],
  ]) {
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name, exact: true }) });
    await expect(row.getByRole('cell').nth(1)).toHaveText(role);
    await expect(row.getByRole('cell').nth(2)).toHaveText(account);
    await expect(row.getByRole('cell').nth(3)).toHaveText(membership);
    await expect(row.getByRole('button')).toHaveCount(0);
  }
  await page
    .getByRole('columnheader', { name: 'Membership', exact: true })
    .scrollIntoViewIfNeeded();
  await settledScreenshot(page, info, 'members-independent-statuses.png');
  const unknownRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'Eva Torres', exact: true }) });
  await unknownRow.getByRole('cell').nth(3).scrollIntoViewIfNeeded();
  await expect(unknownRow.getByText('Unavailable', { exact: true })).toBeInViewport();
  const removedStatus = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'Carol Davis', exact: true }) })
    .getByRole('cell')
    .nth(3);
  await expect(removedStatus).toBeInViewport();
  await settledScreenshot(page, info, 'members-removed-unknown-states.png');
  const removedRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'Carol Davis', exact: true }) });
  await removedRow.getByRole('link', { name: 'Backend', exact: true }).click();
  await expect(page).toHaveURL(/organisations\/o1\/teams\/t12/);
  await page.goBack();
  await expect(page.getByRole('link', { name: 'Alice Chen', exact: true })).toHaveAttribute(
    'href',
    '/users/u101',
  );
  await page.getByRole('link', { name: 'Bob Smith', exact: true }).click();
  await expect(page).toHaveURL(/users\/u102/);
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  const recovery = page.getByRole('button', { name: 'Reactivate access', exact: true });
  await recovery.scrollIntoViewIfNeeded();
  await expect(recovery).toBeInViewport();
  // Recovery remains reachable; this read-only scenario never changes authority.
  await settledScreenshot(page, info, 'disabled-member-recovery.png');
});
