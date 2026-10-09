import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';
// Final prices are arbitrary synthetic UI fixtures, independent of provider rating.

test('operator reviews exact SMS evidence, retries acceptance, checks history and reaches payment recovery', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  const now = new Date().toISOString(); const future = new Date(Date.now() + 86_400_000).toISOString();
  const expiry = new Date(Date.now() + 5 * 60_000).toISOString();
  const fx = { policy: 'ECB_REFERENCE_USD_PER_EUR_V1',
    source: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
    source_digest: 'a'.repeat(64), rate_date: now.slice(0, 10), observed_at: now, expires_at: future, usd_per_eur: '1.1186' };
  const policies: { fx: Array<Record<string, unknown>>; routes: Array<Record<string, unknown>> } = { fx: [], routes: [] };
  let routeEvidence: Record<string, unknown> = {}; let evidenceDocument = ''; let fxAttempts = 0;
  const writes: string[] = [];
  const resource = { id: 'resource-fixture', service_id: 'nessie', organisation_id: 'org-fixture',
    phone_number: '+441234567890', country: 'GB', state: 'refund_required', recovery_reason: 'payment_without_acquired_number' };
  await page.route('**/internal/admin/billing/sms-policies**', async (handler) => {
    const request = handler.request(); const url = new URL(request.url());
    const json = (value: unknown, status = 200) => handler.fulfill({ status, contentType: 'application/json',
      headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) });
    if (request.method() === 'GET' && url.pathname.endsWith('/liabilities')) return json({
      kind: url.searchParams.get('kind'), next_cursor: null, liabilities: [{ id: 'liability-fixture',
        service_id: 'nessie', number_id: 'resource-fixture', allocation_id: 'original-allocation', account_sid: `AC${'a'.repeat(32)}`,
        message_sid: 'SM_fixture', organisation_id: 'org-fixture', team_id: 'original-team',
        state: url.searchParams.get('kind') === 'inbound' ? 'uncollected' : 'uncertain',
        dispatch_id: null, standing_hold_id: null, reserved_credits: url.searchParams.get('kind') === 'outbound' ? '10.000001' : null,
        consumed_credits: null, uncollected_credits: url.searchParams.get('kind') === 'inbound' ? '1.234567' : null,
        created_at: now, updated_at: now,
      }],
    });
    if (request.method() === 'GET' && url.pathname.endsWith('/recovery/resource-fixture')) return json({ ...resource,
      account_sid: null, phone_number_sid: null,
      quote: { id: 'quote-fixture', final_amount: '12.34', final_currency: 'USD', expires_at: future, created_at: now },
      subscriptions: [{ id: 'sub-local', stripe_account_id: 'acct_fixture', stripe_subscription_id: 'sub_fixture',
        initial_invoice_id: 'in_fixture', initial_invoice_paid_at: now, status: 'canceled', livemode: false, cancel_at_period_end: false }],
      refund_action_available: false, operator_next_step: 'Verify original Stripe evidence. Refund required remains unresolved; use the authorized Stripe operator workflow.' });
    if (request.method() === 'GET' && url.pathname.endsWith('/recovery')) return json({
      resources: [{ ...resource, created_at: now, updated_at: now }], next_cursor: null });
    if (request.method() === 'GET') return json(policies);
    writes.push(url.pathname); const input = request.postDataJSON();
    if (url.pathname.endsWith('/fx/preview')) {
      expect(input).toEqual({}); return json({ evidence: fx, preview_token: 'synthetic-fx-preview', preview_expires_at: expiry });
    }
    if (url.pathname.endsWith('/fx/accept')) {
      expect(input).toMatchObject({ preview_token: 'synthetic-fx-preview', policy_understood: true });
      if (++fxAttempts === 1) return json({ error: 'Synthetic failed acceptance' }, 503);
      const accepted = { ...fx, id: 'fx-1', accepted_by_user_id: 'operator-fixture', accepted_at: now,
        acceptance_reason: input.acceptance_reason }; policies.fx.push(accepted); return json(accepted);
    }
    if (url.pathname.endsWith('/routes/preview')) {
      const { evidence, ...dimensions } = input; evidenceDocument = evidence;
      expect(dimensions).toMatchObject({ account_sid: `AC${'a'.repeat(32)}`, country: 'GB', currency: 'USD',
        direction: 'outbound', additional_per_segment: '0.003', additional_per_message: '0.001' });
      routeEvidence = { ...dimensions, evidence_digest: 'b'.repeat(64), observed_at: now };
      return json({ evidence: routeEvidence, evidence_document: evidenceDocument,
        preview_token: 'synthetic-route-preview', preview_expires_at: expiry });
    }
    if (url.pathname.endsWith('/routes/accept')) {
      expect(input).toMatchObject({ preview_token: 'synthetic-route-preview', policy_understood: true,
        complete_segment_bound: true, complete_message_bound: true });
      const { observed_at: _observed, ...terms } = routeEvidence;
      const accepted = { ...terms, id: 'route-1', accepted_by_user_id: 'operator-fixture', accepted_at: now,
        acceptance_reason: input.acceptance_reason }; policies.routes.push(accepted); return json(accepted);
    }
    return json({ error: 'Unexpected operation' }, 400);
  });
  await page.goto('/billing');
  await page.getByRole('button', { name: 'SMS policies', exact: true }).click();
  await expect(page).toHaveURL(/section=sms/);
  await expect(page.getByText('No accepted SMS policies.')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh ECB evidence', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Review ECB reference conversion' });
  await expect(dialog).toContainText('1.1186'); await expect(dialog).toContainText('a'.repeat(64));
  await expect(dialog.getByRole('button', { name: 'Accept immutable policy' })).toBeDisabled();
  await dialog.getByRole('checkbox').check(); await dialog.getByLabel(/^Acceptance reason/).fill('Accept the dated ECB reference conversion for commercial prices.');
  await dialog.getByRole('button', { name: 'Accept immutable policy' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Check accepted history');
  await expect(dialog.getByLabel(/^Acceptance reason/)).toHaveValue('Accept the dated ECB reference conversion for commercial prices.');
  await dialog.getByRole('button', { name: 'Accept immutable policy' }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText(/ECB · .* USD\/EUR 1.1186/)).toBeVisible();
  await page.getByLabel(/^Provider account SID/).fill(`AC${'a'.repeat(32)}`);
  await page.getByLabel(/^Country/, { exact: true }).fill('GB');
  await page.getByLabel(/^Additional charge per segment/).fill('0.003');
  await page.getByLabel(/^Additional charge per message/).fill('0.001');
  await page.getByLabel(/^Evidence source/).fill('https://provider.example/account-terms');
  await page.getByLabel(/^Documented fee evidence/).fill('Synthetic exact account terms cover carrier charges and failed message processing fees.');
  await page.getByLabel(/^Valid until/).fill(future);
  await page.getByRole('button', { name: 'Review route policy' }).click();
  dialog = page.getByRole('dialog', { name: 'Review SMS route fee bounds' });
  await expect(dialog).toContainText(evidenceDocument); await expect(dialog).toContainText(`AC${'a'.repeat(32)}`);
  await dialog.getByLabel(/^Acceptance reason/).fill('Verified the complete route bounds against the original account evidence.');
  await dialog.getByRole('checkbox').nth(0).check(); await dialog.getByRole('checkbox').nth(1).check();
  await expect(dialog.getByRole('button', { name: 'Accept immutable policy' })).toBeDisabled();
  await dialog.getByRole('checkbox').nth(2).check();
  const proof = process.env.UOA_SMS_ADMIN_PROOF_DIR;
  if (proof) { await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, `sms-route-review-${info.project.name}.png`), fullPage: true }); }
  await dialog.getByRole('button', { name: 'Accept immutable policy' }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText('GB · outbound · USD', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review resource', exact: true }).click();
  const recovery = page.getByRole('dialog', { name: 'SMS number recovery' });
  await expect(recovery).toContainText('Frozen customer quote: USD 12.34 per month');
  await expect(recovery).toContainText('Refund required remains unresolved');
  await expect(recovery).toContainText('in_fixture');
  if (proof) await page.screenshot({ path: path.join(proof, `sms-recovery-${info.project.name}.png`), fullPage: true });
  await page.keyboard.press('Escape'); await page.reload();
  await expect(page.getByText('GB · outbound · USD', { exact: true })).toBeVisible();
  await page.getByText('uncollected · SM_fixture', { exact: true }).click();
  await expect(page.getByText('Uncollected credits: 1.234567', { exact: true })).toBeVisible();
  await expect(page.getByText('Consumed credits: Unknown', { exact: true })).toBeVisible();
  await page.getByLabel('Recovery direction').selectOption('outbound');
  await page.getByText('uncertain · SM_fixture', { exact: true }).click();
  await expect(page.getByText('Held credits: 10.000001', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })
    .includes('synthetic-route-preview'))).toBe(false);
  expect(writes.filter((value) => value.endsWith('/routes/accept'))).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('operator verifies existing full refund after a refusal and sees exact resource completion', async ({ page }, info) => {
  const fixture = await installFixtures(page); const now = new Date().toISOString();
  let state = 'refund_required'; let attempts = 0;
  const resource = () => ({ id: 'resource-refund', service_id: 'nessie', organisation_id: 'org-fixture',
    phone_number: '+441234567890', country: 'GB', state,
    recovery_reason: state === 'refund_required' ? 'payment_without_acquired_number' : null });
  const writes: unknown[] = [];
  await page.route('**/internal/admin/billing/sms-policies**', async (handler) => {
    const request = handler.request(); const pathname = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => handler.fulfill({ status,
      contentType: 'application/json', body: JSON.stringify(value) });
    if (request.method() === 'POST') {
      expect(pathname).toContain('/recovery/resource-refund/verify-refund'); const input = request.postDataJSON(); writes.push(input);
      expect(input).toEqual({ subscription_id: 'sub-local', refund_ids: ['re_fixture'],
        reason: 'Verify full original cash refund for the unavailable number.', verify_existing_refunds: true });
      if (++attempts === 1) return json({ error: 'Synthetic pending refund evidence' }, 409);
      state = 'ended'; return json({ resource_id: 'resource-refund', state, evidence_digest: 'c'.repeat(64), refunded_at: now });
    }
    if (pathname.endsWith('/liabilities')) return json({ kind: 'inbound', next_cursor: null, liabilities: [] });
    if (pathname.endsWith('/recovery')) return json({ resources: state === 'ended' ? [] : [{ ...resource(), created_at: now, updated_at: now }], next_cursor: null });
    if (pathname.endsWith('/resource-refund')) return json({ ...resource(), account_sid: null, phone_number_sid: null,
      quote: { id: 'quote-fixture', final_amount: '12.34', final_currency: 'USD', expires_at: now, created_at: now },
      subscriptions: [{ id: 'sub-local', stripe_account_id: 'acct_fixture', stripe_subscription_id: 'sub_fixture',
        initial_invoice_id: 'in_fixture', initial_invoice_paid_at: now, status: 'canceled', livemode: false, cancel_at_period_end: false }],
      refund_action_available: state === 'refund_required',
      operator_next_step: 'Only complete original cash refunds and a canceled subscription can finish recovery. This action never creates refunds.' });
    return json({ fx: [], routes: [] });
  });
  await page.goto('/billing?section=sms'); await page.getByRole('button', { name: 'Review resource' }).click();
  const dialog = page.getByRole('dialog', { name: 'SMS number recovery' });
  await expect(dialog.getByRole('button', { name: 'Verify refund evidence' })).toBeDisabled();
  await dialog.getByLabel(/^Existing Stripe refund IDs/).fill('re_fixture');
  await dialog.getByLabel(/^Refund verification reason/).fill('Verify full original cash refund for the unavailable number.');
  await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Verify refund evidence' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Refund evidence was not accepted');
  await expect(dialog.getByLabel(/^Existing Stripe refund IDs/)).toHaveValue('re_fixture');
  const proof = process.env.UOA_SMS_ADMIN_PROOF_DIR;
  if (proof) { await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, `sms-refund-review-${info.project.name}.png`), fullPage: true }); }
  await dialog.getByRole('button', { name: 'Verify refund evidence' }).click();
  await expect(dialog.getByText('+441234567890 · ended', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Verify refund evidence' })).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(page.getByText('No resources awaiting recovery.')).toBeVisible();
  expect(writes).toHaveLength(2); expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
});
